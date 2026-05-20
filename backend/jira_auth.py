from __future__ import annotations

import json
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

logger = logging.getLogger("jira_copilot.jira")
router = APIRouter()

AUTH_URL = "https://auth.atlassian.com/authorize"
TOKEN_URL = "https://auth.atlassian.com/oauth/token"
ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"
TOKEN_PATH = Path(__file__).with_name("jira_token.json")
if os.path.exists("jira_token.json"):
    os.remove("jira_token.json")
SCOPES = [
    "read:jira-work",
    "read:jira-user",
    "offline_access",
]

_pending_states: set[str] = set()
_token_cache: dict[str, Any] | None = None


def _env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise HTTPException(status_code=500, detail=f"Missing required environment variable {name}")
    return value


def _redirect_uri() -> str:
    return os.getenv("JIRA_REDIRECT_URI", "http://localhost:8000/auth/jira/callback")


def _read_token() -> dict[str, Any] | None:
    global _token_cache
    if _token_cache is not None:
        return _token_cache
    if not TOKEN_PATH.exists():
        return None
    try:
        _token_cache = json.loads(TOKEN_PATH.read_text())
        return _token_cache
    except json.JSONDecodeError:
        logger.error("jira_token_read_failed")
        return None


def _write_token(token: dict[str, Any]) -> None:
    global _token_cache
    _token_cache = token
    TOKEN_PATH.write_text(json.dumps(token, indent=2))


def build_auth_url() -> str:
    state = secrets.token_urlsafe(24)
    _pending_states.add(state)
    params = {
        "audience": "api.atlassian.com",
        "client_id": _env("JIRA_CLIENT_ID"),
        "scope": " ".join(SCOPES),
        "redirect_uri": _redirect_uri(),
        "state": state,
        "response_type": "code",
        "prompt": "consent",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


@router.get("/api/jira/connect")
def jira_connect() -> dict[str, str]:
    url = build_auth_url()
    logger.info("jira_oauth_start")
    return {"auth_url": url}


@router.get("/auth/jira/start")
def jira_start_redirect() -> RedirectResponse:
    return RedirectResponse(build_auth_url())


@router.get("/auth/jira/callback")
def jira_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None) -> HTMLResponse:
    if error:
        logger.error("jira_oauth_denied", extra={"error": error})
        raise HTTPException(status_code=400, detail=error)
    if not code or not state or state not in _pending_states:
        raise HTTPException(status_code=400, detail="Invalid Jira OAuth callback")
    _pending_states.discard(state)
    started = time.perf_counter()
    payload = {
        "grant_type": "authorization_code",
        "client_id": _env("JIRA_CLIENT_ID"),
        "client_secret": _env("JIRA_CLIENT_SECRET"),
        "code": code,
        "redirect_uri": _redirect_uri(),
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(TOKEN_URL, json=payload, headers={"Accept": "application/json"})
            response.raise_for_status()
        token = response.json()
        token["created_at"] = int(time.time())
        _write_token(token)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        logger.info("jira_oauth_success", extra={"elapsed_ms": elapsed_ms})
        return HTMLResponse("<html><body><h2>Jira connected.</h2><p>You can close this tab and return to VS Code.</p></body></html>")
    except httpx.HTTPError as exc:
        logger.error("jira_token_exchange_failed", extra={"error": str(exc)})
        raise HTTPException(status_code=502, detail="Jira token exchange failed") from exc


def get_access_token() -> str:
    token = _read_token()

    if not token:
        raise HTTPException(status_code=401)

    expires_in = token.get("expires_in", 3600)
    created_at = token.get("created_at", 0)

    if time.time() > created_at + expires_in - 60:
        token = refresh_access_token(token["refresh_token"])

    return token["access_token"]

def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    payload = {
        "grant_type": "refresh_token",
        "client_id": _env("JIRA_CLIENT_ID"),
        "client_secret": _env("JIRA_CLIENT_SECRET"),
        "refresh_token": refresh_token,
    }

    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            TOKEN_URL,
            json=payload,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()

    token = response.json()
    token["created_at"] = int(time.time())

    _write_token(token)

    return token

def jira_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {get_access_token()}", "Accept": "application/json"}


def fetch_accessible_resources() -> list[dict[str, Any]]:
    started = time.perf_counter()
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(ACCESSIBLE_RESOURCES_URL, headers=jira_headers())
            response.raise_for_status()
        data = response.json()
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        logger.info("jira_accessible_resources_loaded", extra={"elapsed_ms": elapsed_ms, "count": len(data)})
        return data if isinstance(data, list) else []
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 401:
            raise HTTPException(status_code=401, detail="Jira authorization expired") from exc
        raise HTTPException(status_code=502, detail="Could not load Jira resources") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Jira") from exc


def _cloud_id() -> str:
    configured = os.getenv("JIRA_CLOUD_ID", "").strip()
    if configured:
        return configured
    resources = fetch_accessible_resources()
    if not resources:
        raise HTTPException(status_code=404, detail="No accessible Jira Cloud resources")
    cloud_id = resources[0].get("id")
    if not cloud_id:
        raise HTTPException(status_code=502, detail="Jira resource missing cloud id")
    return str(cloud_id)


def jira_api_url(path: str) -> str:
    return f"https://api.atlassian.com/ex/jira/{_cloud_id()}/rest/api/3{path}"


def fetch_projects() -> list[dict[str, Any]]:
    with httpx.Client(timeout=30.0) as client:
        response = client.get(jira_api_url("/project/search"), headers=jira_headers(), params={"maxResults": 50})
        response.raise_for_status()
    data = response.json()
    return data.get("values", []) if isinstance(data, dict) else []


def fetch_issues(jql: str | None = None, max_results: int = 50) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    start_at = 0
    page_size = min(max_results, 50)
    with httpx.Client(timeout=30.0) as client:
        while len(issues) < max_results:
            response = client.post(
                jira_api_url("/search/jql"),
                headers={
                    **jira_headers(),
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                json={
                    "jql": "project = SCRUM ORDER BY updated DESC",
                    "maxResults": page_size,
                    "fields": [
                        "summary",
                        "description",
                        "status",
                        "priority",
                        "assignee",
                        "labels",
                        "created",
                        "updated",
                    ],
                },
            )
            print("STATUS CODE:", response.status_code)
            print("RESPONSE TEXT:", response.text)
            response.raise_for_status()
            data = response.json()
            batch = data.get("issues", []) if isinstance(data, dict) else []
            issues.extend(batch)
            if start_at + len(batch) >= int(data.get("total", 0)) or not batch:
                break
            start_at += len(batch)
    logger.info("jira_issues_loaded", extra={"count": len(issues)})
    return issues[:max_results]


def fetch_issue(issue_key: str) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(jira_api_url(f"/issue/{issue_key}"), headers=jira_headers())
            response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Unknown Jira issue {issue_key}") from exc
        raise HTTPException(status_code=502, detail="Could not load Jira issue") from exc


def normalize_issue(issue: dict[str, Any]) -> dict[str, Any]:
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    priority = fields.get("priority") or {}
    status = fields.get("status") or {}
    assignee = fields.get("assignee") or {}
    description = fields.get("description")
    if not isinstance(description, str):
        description = json.dumps(description) if description else ""
    return {
        "id": issue.get("key", issue.get("id", "")),
        "title": fields.get("summary") or issue.get("key", "Untitled issue"),
        "description": description,
        "priority": priority.get("name", "Medium") if isinstance(priority, dict) else "Medium",
        "status": status.get("name", "UNKNOWN") if isinstance(status, dict) else "UNKNOWN",
        "assignee": assignee.get("displayName", "Unassigned") if isinstance(assignee, dict) else "Unassigned",
        "labels": fields.get("labels") or [],
        "created_at": fields.get("created") or "",
    }


def load_jira_tickets(max_results: int = 50) -> list[dict[str, Any]]:
    try:
        return [normalize_issue(issue) for issue in fetch_issues(max_results=max_results)]
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 401:
            raise HTTPException(status_code=401, detail="Jira authorization expired") from exc
        raise HTTPException(status_code=502, detail="Jira issue fetch failed") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Jira") from exc


def add_comment(issue_key: str, body: str) -> dict[str, Any]:
    payload = {
        "body": {
            "type": "doc",
            "version": 1,
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": body}]}
            ],
        }
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(jira_api_url(f"/issue/{issue_key}/comment"), headers={**jira_headers(), "Content-Type": "application/json"}, json=payload)
            response.raise_for_status()
        logger.info("jira_comment_added", extra={"issue_key": issue_key})
        return response.json()
    except httpx.HTTPError as exc:
        logger.error("jira_comment_failed", extra={"issue_key": issue_key, "error": str(exc)})
        raise HTTPException(status_code=502, detail="Could not add Jira comment") from exc


def list_transitions(issue_key: str) -> list[dict[str, Any]]:
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(jira_api_url(f"/issue/{issue_key}/transitions"), headers=jira_headers())
            response.raise_for_status()
        data = response.json()
        return data.get("transitions", []) if isinstance(data, dict) else []
    except httpx.HTTPError as exc:
        logger.error("jira_transitions_failed", extra={"issue_key": issue_key, "error": str(exc)})
        raise HTTPException(status_code=502, detail="Could not load Jira transitions") from exc


def transition_issue(issue_key: str, transition_id: str | None = None, transition_name: str | None = None) -> dict[str, Any]:
    selected_id = transition_id
    if not selected_id and transition_name:
        for transition in list_transitions(issue_key):
            if str(transition.get("name", "")).lower() == transition_name.lower():
                selected_id = str(transition.get("id"))
                break
    if not selected_id:
        raise HTTPException(status_code=422, detail="transition_id or valid transition_name is required")
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                jira_api_url(f"/issue/{issue_key}/transitions"),
                headers={**jira_headers(), "Content-Type": "application/json"},
                json={"transition": {"id": selected_id}},
            )
            response.raise_for_status()
        logger.info("jira_transitioned", extra={"issue_key": issue_key, "transition_id": selected_id})
        return {"ok": True, "issue_key": issue_key, "transition_id": selected_id}
    except httpx.HTTPError as exc:
        logger.error("jira_transition_failed", extra={"issue_key": issue_key, "error": str(exc)})
        raise HTTPException(status_code=502, detail="Could not transition Jira issue") from exc


# @router.get("/api/jira/status")
# def jira_status() -> dict[str, Any]:
#     return {"connected": _read_token() is not None}

@router.get("/api/jira/status")
def jira_status() -> dict[str, Any]:
    try:
        get_access_token()
        return {"connected": True}
    except HTTPException:
        return {"connected": False}

@router.get("/api/jira/projects")
def jira_projects() -> list[dict[str, Any]]:
    return fetch_projects()
