from __future__ import annotations

import logging
import time
from typing import TypedDict

import httpx

logger = logging.getLogger("jira_copilot.workspace")
BRIDGE_WORKSPACE_URL = "http://localhost:8001/workspace/files"


class WorkspaceFile(TypedDict, total=False):
    path: str
    content: str
    size: int
    chunks: list[str]


def load_workspace_files(workspace_path: str, max_files: int = 20, query: str = "") -> list[WorkspaceFile]:
    if not workspace_path:
        logger.warning("workspace_path_missing")
        return []
    started = time.perf_counter()
    try:
        with httpx.Client(timeout=35.0) as client:
            response = client.post(
                BRIDGE_WORKSPACE_URL,
                json={"workspacePath": workspace_path, "maxFiles": max_files, "query": query},
            )
            response.raise_for_status()
        data = response.json()
        files = data.get("files", [])
        if not isinstance(files, list):
            raise ValueError("Bridge workspace response missing files array")
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        logger.info("workspace_files_loaded", extra={"elapsed_ms": elapsed_ms, "count": len(files)})
        return [
            {
                "path": str(item.get("path", "")),
                "content": str(item.get("content", "")),
                "size": int(item.get("size", 0) or 0),
                "chunks": item.get("chunks", []),
            }
            for item in files
            if isinstance(item, dict) and item.get("path")
        ]
    except (httpx.TimeoutException, httpx.HTTPError, ValueError) as exc:
        logger.error("workspace_files_failed", extra={"error": str(exc)})
        return []
