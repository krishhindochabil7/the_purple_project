from __future__ import annotations

from datetime import datetime
from typing import Literal, TypedDict

from pydantic import BaseModel, Field


class RejectionContext(BaseModel):
    tag: Literal["WRONG_APPROACH", "TOO_RISKY", "MISREAD_REQUIREMENT", "INCOMPLETE", "OTHER"]
    reason: str
    rejected_step_id: str


class ReasoningStep(BaseModel):
    step_id: str
    node_name: Literal["reason", "plan", "execute"]
    attempt_number: int
    decision: str
    rationale: str
    alternatives_considered: list[str]
    confidence: float = Field(ge=0.0, le=1.0)
    exact_prompt: str
    raw_llm_output: str
    code_diff: str | None
    files_read: list[str]
    tokens_used: int
    timestamp: datetime
    prev_attempt_id: str | None
    rejection_tag: str | None
    rejection_reason: str | None


class HumanDecision(BaseModel):
    gate: Literal["reasoning", "plan", "output"]
    decision: Literal["approved", "rejected"]
    tag: str | None = None
    reason: str | None = None
    decided_at: datetime


LLMProvider = Literal["copilot", "claude"]


class TicketSessionState(TypedDict, total=False):
    ticket_id: str
    workspace_path: str
    llm_provider: LLMProvider
    ticket: dict
    session_id: str
    context_snapshot: dict
    reasoning_steps: list[dict]
    current_plan: list[str] | None
    human_decisions: list[dict]
    execution_results: list[dict]
    rejection_context: dict | None
    status: str
    started_at: str
    committed_at: str | None
    applied_actions: list[str]
    changed_files: list[str]
    validation_results: list[dict]
    rollback_metadata: list[dict]
    retry_metadata: dict
    git_status: dict
