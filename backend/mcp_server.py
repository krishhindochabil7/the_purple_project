from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from langgraph.types import Command
from mcp.server.fastmcp import FastMCP

from execution_engine import apply_updates, rollback
from git_ops import commit_changes, create_branch, git_diff as get_git_diff, git_status as get_git_status, restore_paths, ensure_inside
from graph import graph
from jira_auth import load_jira_tickets
from jira_auth import (
    add_comment,
    build_auth_url,
    fetch_issue,
    fetch_issues,
    fetch_projects,
    list_transitions,
    normalize_issue,
    transition_issue,
)
from llm_copilot import CopilotLLM
from state import HumanDecision
from validation import run_validation as run_workspace_validation
from workspace_bridge import load_workspace_files

BASE_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = Path(__file__).resolve().parent
SESSION_INDEX_PATH = BACKEND_DIR / "mcp_sessions.json"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("jira_copilot.mcp")

mcp = FastMCP("JiraCopilot")
llm = CopilotLLM()


def _load_dotenv() -> None:
    env_path = BACKEND_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _read_sessions() -> dict[str, dict[str, Any]]:
    if not SESSION_INDEX_PATH.exists():
        return {}
    try:
        return json.loads(SESSION_INDEX_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def _write_sessions(data: dict[str, dict[str, Any]]) -> None:
    SESSION_INDEX_PATH.write_text(json.dumps(data, indent=2))


def _remember_session(session_id: str, metadata: dict[str, Any]) -> None:
    data = _read_sessions()
    data[session_id] = metadata
    data["__latest__"] = {"session_id": session_id}
    _write_sessions(data)


def _session(session_id: str | None = None) -> dict[str, Any]:
    data = _read_sessions()
    if session_id is None:
        latest = data.get("__latest__", {}).get("session_id")
        if not latest:
            raise ValueError("No latest MCP workflow session is known")
        session_id = str(latest)
    if session_id not in data:
        raise ValueError(f"Unknown MCP workflow session: {session_id}")
    return data[session_id]


def _config(thread_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread_id}}


def _snapshot(thread_id: str):
    return graph.get_state(_config(thread_id))


def _state_for_session(session_id: str | None = None) -> dict[str, Any]:
    metadata = _session(session_id)
    state = _snapshot(metadata["thread_id"]).values
    if not state:
        raise ValueError("Workflow state not found in LangGraph checkpoint")
    return {"session_id": metadata["session_id"], "thread_id": metadata["thread_id"], **state}


def _current_node(thread_id: str) -> str | None:
    tasks = _snapshot(thread_id).tasks
    return tasks[0].name if tasks else None


def _safe_file(workspace_path: str, relative_path: str) -> Path:
    return ensure_inside(workspace_path, relative_path)


def _workspace_context(workspace_path: str, query: str = "", max_files: int = 40) -> dict[str, str]:
    files = load_workspace_files(workspace_path, max_files=max_files, query=query)
    return {item["path"]: item.get("content", "") for item in files}


def _initial_state(ticket_id: str, session_id: str, workspace_path: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "ticket_id": ticket_id,
        "session_id": session_id,
        "workspace_path": workspace_path,
        "reasoning_steps": [],
        "current_plan": None,
        "human_decisions": [],
        "execution_results": [],
        "rejection_context": None,
        "status": "LOADING",
        "started_at": now,
        "committed_at": None,
        "applied_actions": [],
        "changed_files": [],
        "validation_results": [],
        "rollback_metadata": [],
        "retry_metadata": {},
        "git_status": {},
    }


def _start_workflow(ticket_id: str, workspace_path: str) -> dict[str, Any]:
    session_id = str(uuid4())
    thread_id = f"{ticket_id}:{session_id}"
    graph.invoke(_initial_state(ticket_id, session_id, workspace_path), _config(thread_id))
    metadata = {
        "session_id": session_id,
        "thread_id": thread_id,
        "ticket_id": ticket_id,
        "workspace_path": workspace_path,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    _remember_session(session_id, metadata)
    state = _state_for_session(session_id)
    state["current_node"] = _current_node(thread_id)
    return state


def _decision(session_id: str, decision: str, tag: str | None = None, reason: str | None = None) -> dict[str, Any]:
    metadata = _session(session_id)
    state = _state_for_session(session_id)
    gate_by_status = {
        "PENDING_REVIEW_REASONING": "reasoning",
        "PENDING_REVIEW_PLAN": "plan",
        "PENDING_REVIEW_OUTPUT": "output",
    }
    status = str(state.get("status", ""))
    if status not in gate_by_status:
        raise ValueError(f"Workflow is not waiting for review: {status}")
    human_decision = HumanDecision(
        gate=gate_by_status[status],
        decision=decision,  # type: ignore[arg-type]
        tag=tag,
        reason=reason,
        decided_at=datetime.now(timezone.utc),
    ).model_dump(mode="json")
    graph.invoke(Command(update={"human_decisions": [human_decision]}, resume=human_decision), _config(metadata["thread_id"]))
    updated = _state_for_session(session_id)
    updated["current_node"] = _current_node(metadata["thread_id"])
    return updated


def _auto_approve_until(session_id: str, target_status: str = "PENDING_REVIEW_OUTPUT", max_steps: int = 4) -> dict[str, Any]:
    state = _state_for_session(session_id)
    for _ in range(max_steps):
        if state.get("status") == target_status or not str(state.get("status", "")).startswith("PENDING_REVIEW"):
            break
        state = _decision(session_id, "approved")
    return state


# Jira tools

@mcp.tool()
def jira_oauth_start() -> dict[str, Any]:
    """Return the Atlassian OAuth URL for connecting Jira."""
    return {"auth_url": build_auth_url()}


@mcp.tool()
def jira_list_projects() -> dict[str, Any]:
    """List accessible Jira Cloud projects using the existing OAuth token."""
    return {"projects": fetch_projects()}


@mcp.tool()
def jira_list_tickets(max_results: int = 50) -> dict[str, Any]:
    """List recent Jira tickets/issues."""
    return {"tickets": load_jira_tickets(max_results=max_results)}


@mcp.tool()
def jira_get_ticket(issue_key: str) -> dict[str, Any]:
    """Fetch one Jira issue and normalized ticket fields."""
    issue = fetch_issue(issue_key)
    return {"ticket": normalize_issue(issue), "raw": issue}


@mcp.tool()
def jira_search_tickets(jql: str, max_results: int = 25) -> dict[str, Any]:
    """Search Jira issues with JQL."""
    issues = fetch_issues(jql=jql, max_results=max_results)
    return {"tickets": [normalize_issue(issue) for issue in issues], "raw": issues}


@mcp.tool()
def jira_add_comment(issue_key: str, body: str) -> dict[str, Any]:
    """Add a Jira comment using the existing OAuth integration."""
    return {"comment": add_comment(issue_key, body)}


@mcp.tool()
def jira_transition_ticket(issue_key: str, transition_id: str | None = None, transition_name: str | None = None) -> dict[str, Any]:
    """Transition a Jira ticket by transition id or exact transition name."""
    return transition_issue(issue_key, transition_id=transition_id, transition_name=transition_name)


@mcp.tool()
def jira_list_transitions(issue_key: str) -> dict[str, Any]:
    """List valid transitions for a Jira ticket."""
    return {"transitions": list_transitions(issue_key)}


# Workspace tools

@mcp.tool()
def workspace_search(workspace_path: str, query: str, max_files: int = 20) -> dict[str, Any]:
    """Search/rank real workspace files via the existing workspace retrieval path."""
    return {"files": load_workspace_files(workspace_path, max_files=max_files, query=query)}


@mcp.tool()
def workspace_read_file(workspace_path: str, path: str, max_bytes: int = 200000) -> dict[str, Any]:
    """Read one workspace-relative file with traversal protection."""
    file_path = _safe_file(workspace_path, path)
    content = file_path.read_bytes()
    return {
        "path": path,
        "content": content[:max_bytes].decode("utf-8", errors="replace"),
        "size": len(content),
        "truncated": len(content) > max_bytes,
    }


@mcp.tool()
def workspace_list_files(workspace_path: str, max_files: int = 100) -> dict[str, Any]:
    """List supported source files in a workspace."""
    files = load_workspace_files(workspace_path, max_files=max_files, query="")
    return {"files": [{"path": item["path"], "size": item.get("size", 0)} for item in files]}


@mcp.tool()
def workspace_get_related_files(workspace_path: str, path: str, max_files: int = 20) -> dict[str, Any]:
    """Find likely related files using filename/symbol tokens."""
    safe = _safe_file(workspace_path, path)
    query = f"{safe.stem} {safe.name}"
    return {"files": load_workspace_files(workspace_path, max_files=max_files, query=query)}


# Execution and validation tools

@mcp.tool()
def apply_patch(workspace_path: str, updates: list[dict[str, str]], run_validation: bool = True) -> dict[str, Any]:
    """Apply complete-file updates atomically, validate, rollback on failure, and return real git diff."""
    return apply_updates(workspace_path, updates, validation_required=run_validation)


@mcp.tool()
def execute_ticket_workflow(ticket_id: str, workspace_path: str, auto_approve_reasoning_and_plan: bool = False) -> dict[str, Any]:
    """Start the durable LangGraph workflow for a Jira ticket."""
    state = _start_workflow(ticket_id, workspace_path)
    if auto_approve_reasoning_and_plan:
        state = _auto_approve_until(state["session_id"], "PENDING_REVIEW_OUTPUT")
    return state


@mcp.tool()
def run_validation(workspace_path: str) -> dict[str, Any]:
    """Run auto-detected local validation commands."""
    return run_workspace_validation(workspace_path)


@mcp.tool()
def rollback_changes(workspace_path: str, snapshots: list[dict[str, Any]], reason: str = "MCP requested rollback", approved: bool = False) -> dict[str, Any]:
    """Restore execution-engine backup snapshots. Requires approved=true."""
    if not approved:
        return {"ok": False, "error": "rollback_changes requires approved=true"}
    return rollback(workspace_path, snapshots, reason)


@mcp.tool()
def repair_validation_failures(workspace_path: str, ticket: dict[str, Any], validation_errors: dict[str, Any], max_files: int = 40) -> dict[str, Any]:
    """Ask Copilot for repair edits using validation errors, then apply and validate them."""
    query = json.dumps(validation_errors)[:4000]
    context = _workspace_context(workspace_path, query=query, max_files=max_files)
    updates = llm.generate_file_updates(ticket, ["Repair validation failures"], context, validation_errors=validation_errors)
    result = apply_updates(workspace_path, updates["updates"], validation_required=True)
    return {"rationale": updates["rationale"], **result}


# Git tools

@mcp.tool()
def git_status(workspace_path: str) -> dict[str, Any]:
    """Return branch and short status."""
    return get_git_status(workspace_path)


@mcp.tool()
def git_diff(workspace_path: str, paths: list[str] | None = None) -> dict[str, Any]:
    """Return real git diff for the workspace or selected paths."""
    return {"diff": get_git_diff(workspace_path, paths)}


@mcp.tool()
def git_create_branch(workspace_path: str, branch_name: str, checkout: bool = True, approved: bool = False) -> dict[str, Any]:
    """Create a local branch. Requires approved=true."""
    if not approved:
        return {"ok": False, "error": "git_create_branch requires approved=true"}
    return create_branch(workspace_path, branch_name, checkout=checkout)


@mcp.tool()
def git_commit(workspace_path: str, message: str, paths: list[str] | None = None, approved: bool = False) -> dict[str, Any]:
    """Commit local changes. Requires approved=true. Never pushes."""
    if not approved:
        return {"ok": False, "error": "git_commit requires approved=true"}
    return commit_changes(workspace_path, message, paths)


@mcp.tool()
def git_rollback(workspace_path: str, paths: list[str], approved: bool = False) -> dict[str, Any]:
    """Restore selected paths from git. Requires approved=true."""
    return restore_paths(workspace_path, paths, approved=approved)


# LangGraph workflow tools

@mcp.tool()
def run_ticket_analysis(ticket_id: str, workspace_path: str) -> dict[str, Any]:
    """Run LangGraph through the reasoning checkpoint for a Jira ticket."""
    return _start_workflow(ticket_id, workspace_path)


@mcp.tool()
def run_ticket_implementation(ticket_id: str, workspace_path: str, auto_approve_reasoning_and_plan: bool = True) -> dict[str, Any]:
    """Run LangGraph toward implementation while preserving human review gates."""
    state = _start_workflow(ticket_id, workspace_path)
    if auto_approve_reasoning_and_plan:
        state = _auto_approve_until(state["session_id"], "PENDING_REVIEW_OUTPUT")
    return state


@mcp.tool()
def resume_workflow(session_id: str, decision: str | None = None, tag: str | None = None, reason: str | None = None) -> dict[str, Any]:
    """Resume a checkpointed workflow, optionally submitting a review decision."""
    if decision:
        if decision not in {"approved", "rejected"}:
            raise ValueError("decision must be approved or rejected")
        return _decision(session_id, decision, tag=tag, reason=reason)
    return _state_for_session(session_id)


@mcp.tool()
def review_workflow_state(session_id: str | None = None) -> dict[str, Any]:
    """Inspect current workflow state, review gates, validation, retry and rollback metadata."""
    state = _state_for_session(session_id)
    metadata = _session(session_id)
    state["current_node"] = _current_node(metadata["thread_id"])
    return state


# Resources

@mcp.resource("jira://ticket/{issue_key}")
def jira_ticket_resource(issue_key: str) -> str:
    return json.dumps(jira_get_ticket(issue_key), indent=2)


@mcp.resource("workspace://file/{path}")
def workspace_file_resource(path: str) -> str:
    session = _session(None)
    return json.dumps(workspace_read_file(session["workspace_path"], path), indent=2)


@mcp.resource("execution://latest-diff")
def latest_diff_resource() -> str:
    state = _state_for_session(None)
    results = state.get("execution_results", [])
    diff = results[-1].get("diff") if results else ""
    return diff or ""


@mcp.resource("execution://validation-results")
def validation_results_resource() -> str:
    state = _state_for_session(None)
    return json.dumps(state.get("validation_results", []), indent=2)


@mcp.resource("workflow://session/{session_id}")
def workflow_session_resource(session_id: str) -> str:
    return json.dumps(review_workflow_state(session_id), indent=2)


@mcp.resource("workflow://latest-state")
def latest_state_resource() -> str:
    return json.dumps(review_workflow_state(None), indent=2)


# Prompts

@mcp.prompt()
def implement_jira_ticket(issue_key: str, workspace_path: str) -> str:
    return f"""Implement Jira ticket {issue_key} in workspace {workspace_path} using JiraCopilot MCP tools.
Call run_ticket_implementation, inspect execution://latest-diff and execution://validation-results, then ask for human approval before git_commit."""


@mcp.prompt()
def repair_failed_build(session_id: str) -> str:
    return f"""Repair the failed validation for JiraCopilot workflow {session_id}.
Inspect workflow://session/{session_id}, use repair_validation_failures if needed, then re-run run_validation and show the diff."""


@mcp.prompt()
def analyze_repository_impact(issue_key: str, workspace_path: str) -> str:
    return f"""Analyze implementation impact for Jira ticket {issue_key} in {workspace_path}.
Use jira_get_ticket, workspace_search, workspace_get_related_files, and run_ticket_analysis. Summarize affected files, risks, and validation strategy."""


@mcp.prompt()
def review_git_diff(session_id: str) -> str:
    return f"""Review the git diff for JiraCopilot workflow {session_id}.
Read workflow://session/{session_id}, execution://latest-diff, and execution://validation-results. Identify risks and recommend approve or reject."""


if __name__ == "__main__":
    print("Starting JiraCopilot MCP server...")
    mcp.run(transport="stdio")
