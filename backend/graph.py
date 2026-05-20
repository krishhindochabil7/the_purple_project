from __future__ import annotations

import atexit
import json
import logging
import operator
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from langgraph.graph import END, StateGraph
from langgraph.checkpoint.sqlite import SqliteSaver

from execution_engine import apply_updates
from git_ops import commit_changes, git_status
from jira_auth import fetch_issue, load_jira_tickets, normalize_issue
from llm_copilot import CopilotLLM
from state import ReasoningStep, TicketSessionState
from workspace_bridge import load_workspace_files


BASE_DIR = Path(__file__).resolve().parents[1]
logger = logging.getLogger("jira_copilot.graph")
llm = CopilotLLM()
ticket_store: dict[str, str] = {}
MAX_EXECUTION_REPAIRS = 2


class GraphState(TicketSessionState):
    reasoning_steps: Annotated[list[dict], operator.add]
    human_decisions: Annotated[list[dict], operator.add]
    execution_results: Annotated[list[dict], operator.add]
    validation_results: Annotated[list[dict], operator.add]
    rollback_metadata: Annotated[list[dict], operator.add]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_tickets() -> list[dict]:
    try:
        tickets = load_jira_tickets()
        return [{**ticket, "status": ticket_store.get(ticket["id"], ticket["status"])} for ticket in tickets]
    except Exception as exc:
        logger.warning("jira_ticket_load_failed", extra={"error": str(exc)})
        return []


def get_ticket(ticket_id: str) -> dict:
    for ticket in load_tickets():
        if ticket["id"] == ticket_id:
            updated = dict(ticket)
            updated["status"] = ticket_store.get(ticket_id, ticket["status"])
            return updated
    try:
        ticket = normalize_issue(fetch_issue(ticket_id))
        ticket["status"] = ticket_store.get(ticket_id, ticket["status"])
        return ticket
    except Exception as exc:
        raise ValueError(f"Unknown ticket id: {ticket_id}: {exc}") from exc


def context_files_from_state(state: TicketSessionState) -> dict[str, str]:
    snapshot_files = (state.get("context_snapshot") or {}).get("files") or []
    return {str(item["path"]): str(item.get("content", "")) for item in snapshot_files if item.get("path")}


def read_context(state: TicketSessionState, ticket: dict | None = None) -> dict[str, str]:
    workspace_path = state.get("workspace_path", "")
    query = ""
    if ticket:
        query = " ".join([str(ticket.get("id", "")), str(ticket.get("title", "")), str(ticket.get("description", "")), " ".join(ticket.get("labels", []) or [])])
    files = load_workspace_files(workspace_path, max_files=40, query=query)
    return {item["path"]: item["content"] for item in files}


def latest_step(state: TicketSessionState, node_name: str | None = None) -> dict | None:
    steps = state.get("reasoning_steps", [])
    if node_name:
        steps = [step for step in steps if step["node_name"] == node_name]
    return steps[-1] if steps else None


def attempt_number(state: TicketSessionState, node_name: str) -> int:
    return len([step for step in state.get("reasoning_steps", []) if step["node_name"] == node_name]) + 1


def latest_decision(state: TicketSessionState, gate: str) -> dict | None:
    decisions = [d for d in state.get("human_decisions", []) if d.get("gate") == gate]
    return decisions[-1] if decisions else None


def prompt_for(node: str, ticket: dict, context_files: dict[str, str], rejection_context: dict | None) -> str:
    base = [
        f"You are JiraCopilot working on {ticket['id']}: {ticket['title']}.",
        f"Description: {ticket['description']}",
    ]
    if rejection_context:
        base.append(
            "Human rejection context only: "
            f"{rejection_context['tag']} - {rejection_context['reason']}"
        )
    else:
        for filename, content in context_files.items():
            numbered = "\n".join(f"{idx + 1}: {line}" for idx, line in enumerate(content.splitlines()))
            base.append(f"File: {filename}\n{numbered}")
    base.append(f"Return a structured {node} decision with rationale, alternatives, and confidence.")
    return "\n\n".join(base)


def build_step(
    state: TicketSessionState,
    node_name: str,
    decision: str,
    rationale: str,
    alternatives: list[str],
    confidence: float,
    prompt: str,
    raw_output,
    files_read: list[str],
    code_diff: str | None = None,
    prev_attempt_id: str | None = None,
    rejection_context: dict | None = None,
) -> dict:
    return ReasoningStep(
        step_id=str(uuid4()),
        node_name=node_name,
        attempt_number=attempt_number(state, node_name),
        decision=decision,
        rationale=rationale,
        alternatives_considered=alternatives,
        confidence=confidence,
        exact_prompt=prompt,
        raw_llm_output=json.dumps(raw_output, indent=2),
        code_diff=code_diff,
        files_read=files_read,
        tokens_used=int(len(prompt.split()) * 1.3),
        timestamp=datetime.now(timezone.utc),
        prev_attempt_id=prev_attempt_id,
        rejection_tag=rejection_context["tag"] if rejection_context else None,
        rejection_reason=rejection_context["reason"] if rejection_context else None,
    ).model_dump(mode="json")


def load_context(state: TicketSessionState) -> dict:
    ticket = get_ticket(state["ticket_id"])
    files = read_context(state, ticket)
    return {
        "ticket": ticket,
        "context_snapshot": {
            "files": [{"path": name, "content": content} for name, content in files.items()],
            "loaded_at": utc_now(),
        },
        "status": "REASONING",
    }


def reason(state: TicketSessionState) -> dict:
    ticket = state["ticket"]
    rejection_context = state.get("rejection_context")
    files = {} if rejection_context else context_files_from_state(state)
    prompt = prompt_for("reasoning", ticket, files, rejection_context)
    previous = latest_step(state, "reason") if rejection_context else None
    output = llm.generate_reasoning(ticket, files)
    summary = llm.extract_reasoning_summary(prompt, output)
    raw = {**output, "reasoning_summary": summary}
    step = build_step(
        state,
        "reason",
        output["decision"],
        output["rationale"],
        output["alternatives_considered"],
        output["confidence"],
        prompt,
        raw,
        list(files.keys()),
        prev_attempt_id=previous["step_id"] if previous else None,
        rejection_context=rejection_context,
    )
    return {"reasoning_steps": [step], "rejection_context": None, "status": "PENDING_REVIEW_REASONING"}


def human_review_reasoning(state: TicketSessionState) -> dict:
    decision = latest_decision(state, "reasoning")
    if decision and decision["decision"] == "rejected":
        return {
            "rejection_context": {
                "tag": decision.get("tag") or "OTHER",
                "reason": decision.get("reason") or "No reason supplied",
                "rejected_step_id": latest_step(state, "reason")["step_id"],
            },
            "status": "REASONING",
        }
    return {"status": "PLANNING"}


def plan(state: TicketSessionState) -> dict:
    ticket = state["ticket"]
    rejection_context = state.get("rejection_context")
    files = {} if rejection_context else context_files_from_state(state)
    reasoning = latest_step(state, "reason")
    prompt = prompt_for("planning", ticket, files, rejection_context)
    previous = latest_step(state, "plan") if rejection_context else None
    plan_steps = llm.generate_plan(ticket, reasoning["decision"])
    output = {"plan": plan_steps, "reasoning_decision": reasoning["decision"]}
    step = build_step(
        state,
        "plan",
        f"Use a {len(plan_steps)} step implementation plan for {ticket['id']}.",
        "The plan follows the approved reasoning and orders the work from inspection through validation.",
        ["Start with tests first - deferred because this workflow validates after generating a reviewed working-tree patch."],
        0.84,
        prompt,
        output,
        list(files.keys()),
        prev_attempt_id=previous["step_id"] if previous else None,
        rejection_context=rejection_context,
    )
    return {
        "reasoning_steps": [step],
        "current_plan": plan_steps,
        "rejection_context": None,
        "status": "PENDING_REVIEW_PLAN",
    }


def human_review_plan(state: TicketSessionState) -> dict:
    decision = latest_decision(state, "plan")
    if decision and decision["decision"] == "rejected":
        return {
            "rejection_context": {
                "tag": decision.get("tag") or "OTHER",
                "reason": decision.get("reason") or "No reason supplied",
                "rejected_step_id": latest_step(state, "plan")["step_id"],
            },
            "status": "PLANNING",
        }
    return {"status": "EXECUTING"}


def execute(state: TicketSessionState) -> dict:
    ticket = state["ticket"]
    rejection_context = state.get("rejection_context")
    context_files = context_files_from_state(state)
    workspace_path = state.get("workspace_path", "")
    if not workspace_path:
        raise ValueError("workspace_path is required for real execution")

    previous = latest_step(state, "execute") if rejection_context else None
    prompt = prompt_for("execution", ticket, context_files, rejection_context)
    validation_errors = None
    attempts: list[dict] = []
    final_result: dict | None = None

    for repair_attempt in range(MAX_EXECUTION_REPAIRS + 1):
        started_at = utc_now()
        update_response = llm.generate_file_updates(
            ticket,
            state.get("current_plan") or [],
            context_files,
            validation_errors=validation_errors,
        )
        try:
            apply_result = apply_updates(workspace_path, update_response["updates"])
        except Exception as exc:
            apply_result = {
                "ok": False,
                "changed_files": [],
                "diff": "",
                "validation": {"ok": False, "error": str(exc), "commands": []},
                "rollback": {"rolled_back": True, "reason": str(exc), "files": []},
                "git": git_status(workspace_path),
            }
        attempt = {
            "attempt": repair_attempt + 1,
            "started_at": started_at,
            "completed_at": utc_now(),
            "rationale": update_response["rationale"],
            "requested_updates": [item["path"] for item in update_response["updates"]],
            **apply_result,
        }
        attempts.append(attempt)
        logger.info(
            "execution_attempt_complete",
            extra={"ticket_id": ticket["id"], "attempt": repair_attempt + 1, "ok": bool(apply_result.get("ok"))},
        )
        if apply_result.get("ok"):
            final_result = attempt
            break
        validation_errors = apply_result.get("validation")

    if final_result is None:
        final_result = attempts[-1]

    changed_files = list(final_result.get("changed_files") or [])
    diff = str(final_result.get("diff") or "")
    validation = final_result.get("validation") or {}
    rollback = final_result.get("rollback") or {}
    execution_record = {
        "file": ", ".join(changed_files) if changed_files else "no files changed",
        "files": changed_files,
        "diff": diff,
        "validation": validation,
        "rollback": rollback,
        "repair_attempts": attempts,
        "step": "\n".join(state.get("current_plan") or []),
        "applied_at": utc_now(),
    }
    output = {
        "result": execution_record,
        "git": final_result.get("git"),
        "validation_ok": bool(validation.get("ok")),
        "repair_attempts": len(attempts),
    }
    step = build_step(
        state,
        "execute",
        f"Applied real workspace edits for {ticket['id']}" if validation.get("ok") else f"Execution failed validation for {ticket['id']} and changes were rolled back.",
        "Copilot generated complete file updates, the backend wrote them atomically, ran validation, and captured git diff from the filesystem.",
        ["Keep execution simulated - rejected because this workflow now requires real repository mutation and validation."],
        0.78 if validation.get("ok") else 0.35,
        prompt,
        output,
        list(context_files.keys()),
        code_diff=diff or None,
        prev_attempt_id=previous["step_id"] if previous else None,
        rejection_context=rejection_context,
    )
    return {
        "reasoning_steps": [step],
        "execution_results": [execution_record],
        "applied_actions": changed_files,
        "changed_files": changed_files,
        "validation_results": [validation],
        "rollback_metadata": [rollback],
        "retry_metadata": {"execution_attempts": len(attempts), "max_repairs": MAX_EXECUTION_REPAIRS},
        "git_status": final_result.get("git"),
        "rejection_context": None,
        "status": "PENDING_REVIEW_OUTPUT",
    }

def human_review_output(state: TicketSessionState) -> dict:
    decision = latest_decision(state, "output")
    if decision and decision["decision"] == "rejected":
        return {
            "rejection_context": {
                "tag": decision.get("tag") or "OTHER",
                "reason": decision.get("reason") or "No reason supplied",
                "rejected_step_id": latest_step(state, "execute")["step_id"],
            },
            "status": "EXECUTING",
        }
    return {"status": "COMMITTING"}


def commit(state: TicketSessionState) -> dict:
    workspace_path = state.get("workspace_path", "")
    changed_files = state.get("changed_files", [])
    commit_result = {"ok": False, "error": "No workspace path or changed files available"}
    if workspace_path and changed_files:
        message = f"{state['ticket_id']}: apply JiraCopilot changes"
        commit_result = commit_changes(workspace_path, message, changed_files)
    if commit_result.get("ok"):
        ticket_store[state["ticket_id"]] = "DONE"
        return {"status": "COMMITTED", "committed_at": utc_now(), "git_status": git_status(workspace_path)}
    return {"status": "COMMIT_FAILED", "committed_at": None, "git_status": commit_result}


def route_reasoning(state: TicketSessionState) -> str:
    decision = latest_decision(state, "reasoning")
    return "reason" if decision and decision["decision"] == "rejected" else "plan"


def route_plan(state: TicketSessionState) -> str:
    decision = latest_decision(state, "plan")
    return "plan" if decision and decision["decision"] == "rejected" else "execute"


def route_output(state: TicketSessionState) -> str:
    decision = latest_decision(state, "output")
    return "execute" if decision and decision["decision"] == "rejected" else "commit"


def build_graph():
    builder = StateGraph(GraphState)
    builder.add_node("load_context", load_context)
    builder.add_node("reason", reason)
    builder.add_node("human_review_reasoning", human_review_reasoning)
    builder.add_node("plan", plan)
    builder.add_node("human_review_plan", human_review_plan)
    builder.add_node("execute", execute)
    builder.add_node("human_review_output", human_review_output)
    builder.add_node("commit", commit)

    builder.set_entry_point("load_context")
    builder.add_edge("load_context", "reason")
    builder.add_edge("reason", "human_review_reasoning")
    builder.add_conditional_edges("human_review_reasoning", route_reasoning, {"reason": "reason", "plan": "plan"})
    builder.add_edge("plan", "human_review_plan")
    builder.add_conditional_edges("human_review_plan", route_plan, {"plan": "plan", "execute": "execute"})
    builder.add_edge("execute", "human_review_output")
    builder.add_conditional_edges("human_review_output", route_output, {"execute": "execute", "commit": "commit"})
    builder.add_edge("commit", END)
    return builder


AUDIT_DB_PATH = BASE_DIR / "backend" / "audit.db"
with sqlite3.connect(str(AUDIT_DB_PATH)) as _conn:
    _conn.execute("PRAGMA journal_mode=WAL;")
    _conn.execute("PRAGMA synchronous=NORMAL;")

_checkpointer_cm = SqliteSaver.from_conn_string(str(AUDIT_DB_PATH))
checkpointer = _checkpointer_cm.__enter__()
atexit.register(_checkpointer_cm.__exit__, None, None, None)

graph = build_graph().compile(
    checkpointer=checkpointer,
    interrupt_before=["human_review_reasoning", "human_review_plan", "human_review_output"],
)


def print_graph_ascii() -> None:
    fallback = """
load_context -> reason -> human_review_reasoning
human_review_reasoning -> reason [rejected]
human_review_reasoning -> plan [approved]
plan -> human_review_plan
human_review_plan -> plan [rejected]
human_review_plan -> execute [approved]
execute -> human_review_output
human_review_output -> execute [rejected]
human_review_output -> commit [approved]
commit -> END
""".strip()
    try:
        print(graph.get_graph().draw_ascii())
    except Exception as exc:
        print(f"Could not draw graph ASCII: {exc}")
        print(fallback)
