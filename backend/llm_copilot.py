from __future__ import annotations

import json
import logging
import time
from typing import Any, TypedDict

import httpx

BRIDGE_URL = "http://localhost:8001/copilot/complete"

logger = logging.getLogger("jira_copilot.llm")


class ReasoningResponse(TypedDict):
    decision: str
    rationale: str
    alternatives_considered: list[str]
    confidence: float


class ExecutionResponse(TypedDict):
    file: str
    before: str
    after: str
    diff: str


class FileUpdateResponse(TypedDict):
    updates: list[dict[str, str]]
    rationale: str


class CopilotLLM:
    def __init__(self, bridge_url: str = BRIDGE_URL, timeout_seconds: float = 120.0, retries: int = 2):
        self.bridge_url = bridge_url
        self.timeout_seconds = timeout_seconds
        self.retries = retries

    def _complete(self, prompt: str) -> str:
        payload = {"messages": [{"role": "user", "content": prompt}]}
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 2):
            started = time.perf_counter()
            try:
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    response = client.post(self.bridge_url, json=payload)
                    response.raise_for_status()
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                logger.info("copilot_complete_success", extra={"attempt": attempt, "elapsed_ms": elapsed_ms})
                data = response.json()
                content = data.get("content")
                if not isinstance(content, str):
                    raise ValueError("Bridge response missing string content")
                return content
            except (httpx.TimeoutException, httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                logger.warning(
                    "copilot_complete_retry",
                    extra={"attempt": attempt, "elapsed_ms": elapsed_ms, "error": str(exc)},
                )
                last_error = exc
                if attempt <= self.retries:
                    time.sleep(0.5 * attempt)
        raise RuntimeError(f"Copilot bridge request failed: {last_error}")

    def _json(self, prompt: str) -> dict[str, Any]:
        content = self._complete(prompt)
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            start = content.find("{")
            end = content.rfind("}")
            if start >= 0 and end > start:
                return json.loads(content[start:end + 1])
            raise ValueError(f"Copilot response was not JSON: {content[:500]}")

    @staticmethod
    def _context_text(context_files: dict[str, str]) -> str:
        parts = []
        for name, content in context_files.items():
            parts.append(f"File: {name}\n{content}")
        return "\n\n".join(parts)

    @staticmethod
    def _coerce_reasoning(data: dict[str, Any]) -> ReasoningResponse:
        alternatives = data.get("alternatives_considered") or data.get("alternatives") or []
        if isinstance(alternatives, str):
            alternatives = [alternatives]
        if not data.get("decision") or not data.get("rationale"):
            raise ValueError("Copilot reasoning response missing decision or rationale")
        return {
            "decision": str(data["decision"]),
            "rationale": str(data["rationale"]),
            "alternatives_considered": [str(item) for item in alternatives],
            "confidence": max(0.0, min(1.0, float(data.get("confidence") or 0.65))),
        }

    def generate_reasoning(self, ticket: dict[str, Any], context_files: dict[str, str]) -> ReasoningResponse:
        prompt = f"""You are JiraCopilot. Analyze this Jira ticket and repository context.
Return only valid JSON with keys: decision, rationale, alternatives_considered (array), confidence (0-1).

IMPORTANT: Exclude virtual environment directories (e.g., .venv, .venv_*, venv, __pycache__), their contents, and .env configuration files from your analysis entirely. Focus only on the application source code.

Ticket:
{json.dumps(ticket, indent=2)}

Repository context:
{self._context_text(context_files)}
"""
        return self._coerce_reasoning(self._json(prompt))

    def generate_plan(self, ticket: dict[str, Any], reasoning: str) -> list[str]:
        prompt = f"""Create a concise implementation plan for this Jira ticket.
Return only valid JSON with key: plan (array of strings).

Ticket:
{json.dumps(ticket, indent=2)}

Approved reasoning:
{reasoning}
"""
        data = self._json(prompt)
        plan = data.get("plan") or data.get("steps") or []
        if isinstance(plan, str):
            plan = [line.strip(" -") for line in plan.splitlines() if line.strip()]
        steps = [str(step) for step in plan][:10]
        if not steps:
            raise ValueError("Copilot plan response missing non-empty plan")
        return steps

    def generate_execution(self, ticket: dict[str, Any], plan_step: str, file_content: str) -> ExecutionResponse:
        prompt = f"""Generate the code-change artifact for one implementation step.
Return only valid JSON with keys: file, before, after, diff. The diff must be a unified diff.

Ticket:
{json.dumps(ticket, indent=2)}

Plan step:
{plan_step}

Repository context:
{file_content}
"""
        data = self._json(prompt)
        required = ["file", "before", "after", "diff"]
        missing = [key for key in required if not isinstance(data.get(key), str)]
        if missing:
            raise ValueError(f"Copilot execution response missing required keys: {missing}")
        return {
            "file": data["file"],
            "before": data["before"],
            "after": data["after"],
            "diff": data["diff"],
        }


    def generate_file_updates(
        self,
        ticket: dict[str, Any],
        plan_steps: list[str],
        context_files: dict[str, str],
        validation_errors: dict[str, Any] | None = None,
    ) -> FileUpdateResponse:
        prompt = f"""You are JiraCopilot acting as a local coding agent.
Generate exact file updates for the requested Jira ticket.

Rules:
- Return only valid JSON.
- Do not include markdown fences.
- Do not invent files unless necessary.
- For every changed file, return the COMPLETE new file content.
- Preserve unrelated code and formatting.
- If validation_errors are provided, repair the previous attempt.
- Do NOT modify, create, or reference virtual environment files (e.g., .venv*, venv/, __pycache__/) or .env configuration files. Only modify application source code.

JSON schema:
{{
  "rationale": "short explanation",
  "updates": [
    {{"path": "relative/path.ext", "content": "complete updated file content"}}
  ]
}}

Ticket:
{json.dumps(ticket, indent=2)}

Plan:
{json.dumps(plan_steps, indent=2)}

Validation errors from previous attempt:
{json.dumps(validation_errors or {}, indent=2)}

Repository context:
{self._context_text(context_files)}
"""
        data = self._json(prompt)
        updates = data.get("updates")
        if not isinstance(updates, list) or not updates:
            raise ValueError("Copilot file update response missing non-empty updates array")
        normalized: list[dict[str, str]] = []
        for item in updates:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
                raise ValueError("Each Copilot update must include string path and content")
            normalized.append({"path": item["path"], "content": item["content"]})
        rationale = data.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            raise ValueError("Copilot file update response missing rationale")
        return {"updates": normalized, "rationale": rationale}

    def extract_reasoning_summary(self, input_prompt: str, output: Any) -> dict[str, Any]:
        prompt = f"""Summarize the reasoning trace for audit review.
Return only valid JSON with keys: summary (string), key_factors (array of strings).

Prompt:
{input_prompt}

Output:
{json.dumps(output, indent=2) if not isinstance(output, str) else output}
"""
        try:
            data = self._json(prompt)
            factors = data.get("key_factors") or []
            if isinstance(factors, str):
                factors = [factors]
            return {"summary": str(data.get("summary") or "No summary returned."), "key_factors": [str(item) for item in factors]}
        except Exception as exc:
            logger.warning("reasoning_summary_failed", extra={"error": str(exc)})
            return {
                "summary": "Summary generation failed; raw reasoning output is preserved in the audit log.",
                "key_factors": [str(exc)],
            }
