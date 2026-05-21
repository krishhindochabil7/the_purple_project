from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import uuid4
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langgraph.types import Command
from pydantic import BaseModel

from graph import graph, print_graph_ascii
from jira_auth import load_jira_tickets, router as jira_router
from state import HumanDecision

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("jira_copilot.backend")

app = FastAPI(title="JiraCopilot Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(jira_router)

sessions: dict[str, dict] = {}


class StartSessionRequest(BaseModel):
    ticket_id: str
    workspace_path: str = ""
    llm_provider: str = "copilot"


class DecisionRequest(BaseModel):
    decision: str
    tag: str | None = None
    reason: str | None = None


@app.on_event("startup")
def startup_event():
    print_graph_ascii()


def config_for(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def snapshot(thread_id: str):
    return graph.get_state(config_for(thread_id))


def current_state(thread_id: str) -> dict:
    state = snapshot(thread_id).values
    if not state:
        raise HTTPException(status_code=404, detail="Session state not found")
    return state


def current_node(thread_id: str) -> str | None:
    tasks = snapshot(thread_id).tasks
    return tasks[0].name if tasks else None


def response_state(session_id: str) -> dict:
    session = sessions[session_id]
    state = current_state(session["thread_id"])
    latest = state.get("reasoning_steps", [])[-1] if state.get("reasoning_steps") else None
    return {
        "session_id": session_id,
        "status": state.get("status"),
        "current_node": current_node(session["thread_id"]),
        "ticket": state.get("ticket"),
        "context_snapshot": state.get("context_snapshot"),
        "latest_reasoning_step": latest,
        "current_plan": state.get("current_plan"),
        "human_decisions": state.get("human_decisions", []),
        "reasoning_steps": state.get("reasoning_steps", []),
        "reasoning_steps_count": len(state.get("reasoning_steps", [])),
        "execution_results": state.get("execution_results", []),
        "changed_files": state.get("changed_files", []),
        "validation_results": state.get("validation_results", []),
        "rollback_metadata": state.get("rollback_metadata", []),
        "retry_metadata": state.get("retry_metadata"),
        "git_status": state.get("git_status"),
    }


@app.post("/api/session/start")
def start_session(body: StartSessionRequest):
    session_id = str(uuid4())
    thread_id = f"{body.ticket_id}:{session_id}"
    started_at = datetime.now(timezone.utc).isoformat()
    llm_provider = body.llm_provider if body.llm_provider in ("copilot", "claude") else "copilot"
    initial_state = {
        "ticket_id": body.ticket_id,
        "session_id": session_id,
        "workspace_path": body.workspace_path,
        "llm_provider": llm_provider,
        "reasoning_steps": [],
        "current_plan": None,
        "human_decisions": [],
        "execution_results": [],
        "rejection_context": None,
        "status": "LOADING",
        "started_at": started_at,
        "committed_at": None,
        "applied_actions": [],
        "changed_files": [],
        "validation_results": [],
        "rollback_metadata": [],
        "retry_metadata": {},
        "git_status": {},
    }
    try:
        logger.info("session_start", extra={"ticket_id": body.ticket_id, "workspace_path": body.workspace_path})
        graph.invoke(initial_state, config_for(thread_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    sessions[session_id] = {"thread_id": thread_id, "ticket_id": body.ticket_id, "started_at": started_at, "workspace_path": body.workspace_path}
    state = current_state(thread_id)
    return {
        "session_id": session_id,
        "thread_id": thread_id,
        "ticket": state.get("ticket"),
        "status": state.get("status"),
    }


@app.get("/api/session/{session_id}/state")
def get_session_state(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Unknown session")
    return response_state(session_id)


@app.post("/api/session/{session_id}/decision")
def post_decision(session_id: str, body: DecisionRequest):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Unknown session")
    session = sessions[session_id]
    state = current_state(session["thread_id"])
    status = state.get("status", "")
    gate_by_status = {
        "PENDING_REVIEW_REASONING": "reasoning",
        "PENDING_REVIEW_PLAN": "plan",
        "PENDING_REVIEW_OUTPUT": "output",
    }
    if status not in gate_by_status:
        raise HTTPException(status_code=409, detail=f"Session is not waiting for review: {status}")
    if body.decision not in {"approved", "rejected"}:
        raise HTTPException(status_code=422, detail="decision must be approved or rejected")

    human_decision = HumanDecision(
        gate=gate_by_status[status],
        decision=body.decision,
        tag=body.tag,
        reason=body.reason,
        decided_at=datetime.now(timezone.utc),
    ).model_dump(mode="json")
    graph.invoke(
        Command(update={"human_decisions": [human_decision]}, resume=human_decision),
        config_for(session["thread_id"]),
    )
    return response_state(session_id)


@app.get("/api/session/{session_id}/audit")
def get_audit(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Unknown session")
    session = sessions[session_id]
    state = current_state(session["thread_id"])
    timeline = []
    for step in state.get("reasoning_steps", []):
        timeline.append({"type": "reasoning_step", "timestamp": step["timestamp"], **step})
    for decision in state.get("human_decisions", []):
        timeline.append({"type": "human_decision", "timestamp": decision["decided_at"], **decision})
    for result in state.get("execution_results", []):
        timeline.append({"type": "execution_result", "timestamp": result["applied_at"], **result})
    timeline.sort(key=lambda event: event["timestamp"])
    return {
        "session_id": session_id,
        "ticket": state.get("ticket"),
        "started_at": state.get("started_at"),
        "committed_at": state.get("committed_at"),
        "total_attempts": max(0, len(state.get("reasoning_steps", [])) - 3),
        "reasoning_steps": state.get("reasoning_steps", []),
        "human_decisions": state.get("human_decisions", []),
        "execution_results": state.get("execution_results", []),
        "validation_results": state.get("validation_results", []),
        "rollback_metadata": state.get("rollback_metadata", []),
        "retry_metadata": state.get("retry_metadata"),
        "git_status": state.get("git_status"),
        "context_snapshot": state.get("context_snapshot"),
        "timeline": timeline,
    }


@app.get("/api/tickets")
def tickets():
    logger.info("tickets_requested")
    return load_jira_tickets()
