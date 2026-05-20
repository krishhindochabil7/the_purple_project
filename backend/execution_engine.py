from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, TypedDict

from git_ops import ensure_inside, git_diff, git_status
from validation import prewrite_validate, run_validation

logger = logging.getLogger("jira_copilot.execution")


class FileUpdate(TypedDict):
    path: str
    content: str
    rationale: str


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
        handle.write(content)
        temp_name = handle.name
    os.replace(temp_name, path)


def _snapshot(path: Path, backup_root: Path, workspace_root: Path) -> dict[str, Any]:
    rel = path.relative_to(workspace_root).as_posix()
    backup_path = backup_root / rel
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    if existed:
        shutil.copy2(path, backup_path)
    else:
        backup_path.write_text("", encoding="utf-8")
    return {
        "path": rel,
        "backup_path": str(backup_path),
        "existed": existed,
        "sha256": _sha256(original),
    }


def rollback(workspace_path: str, snapshots: list[dict[str, Any]], reason: str) -> dict[str, Any]:
    root = Path(workspace_path).resolve()
    restored: list[str] = []
    for snapshot in snapshots:
        target = ensure_inside(str(root), str(snapshot["path"]))
        if snapshot.get("existed"):
            backup = Path(str(snapshot["backup_path"]))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup, target)
        elif target.exists():
            target.unlink()
        restored.append(str(snapshot["path"]))
    logger.warning("rollback_complete", extra={"reason": reason, "files": restored})
    return {"rolled_back": True, "reason": reason, "files": restored, "rolled_back_at": time.time()}


def apply_updates(
    workspace_path: str,
    updates: list[FileUpdate],
    validation_required: bool = True,
) -> dict[str, Any]:
    root = Path(workspace_path).resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"Invalid workspace path: {workspace_path}")
    if not updates:
        raise ValueError("Copilot returned no file updates")

    started = time.perf_counter()
    backup_root = root / ".jiracopilot" / "backups" / str(int(time.time() * 1000))
    snapshots: list[dict[str, Any]] = []
    changed_files: list[str] = []
    prewrite_results: list[dict[str, Any]] = []

    try:
        for update in updates:
            rel_path = update["path"]
            content = update["content"]
            if not rel_path or not isinstance(content, str):
                raise ValueError("Each file update requires path and content")
            target = ensure_inside(str(root), rel_path)
            snapshots.append(_snapshot(target, backup_root, root))
            syntax = prewrite_validate(target, content)
            prewrite_results.append(syntax)
            if not syntax["ok"]:
                raise ValueError(f"Pre-write validation failed for {rel_path}: {syntax['error']}")
            _atomic_write(target, content)
            changed_files.append(rel_path)
            logger.info("file_written", extra={"path": rel_path, "bytes": len(content.encode("utf-8"))})

        validation = run_validation(str(root)) if validation_required else {"ok": True, "skipped": True, "reason": "Validation disabled", "commands": []}
        diff = git_diff(str(root), changed_files)
        status = git_status(str(root))
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        if not validation["ok"]:
            rollback_meta = rollback(str(root), snapshots, "validation_failed")
            failed_diff = diff
            return {
                "ok": False,
                "changed_files": changed_files,
                "diff": failed_diff,
                "validation": validation,
                "prewrite_validation": prewrite_results,
                "rollback": rollback_meta,
                "git": status,
                "elapsed_ms": elapsed_ms,
            }
        return {
            "ok": True,
            "changed_files": changed_files,
            "diff": diff,
            "validation": validation,
            "prewrite_validation": prewrite_results,
            "rollback": {"rolled_back": False, "snapshots": snapshots},
            "git": status,
            "elapsed_ms": elapsed_ms,
        }
    except Exception as exc:
        rollback_meta = rollback(str(root), snapshots, str(exc)) if snapshots else {"rolled_back": False, "reason": str(exc), "files": []}
        logger.error("execution_apply_failed", extra={"error": str(exc)})
        raise RuntimeError(f"Execution failed and rollback was attempted: {exc}; rollback={rollback_meta}") from exc
