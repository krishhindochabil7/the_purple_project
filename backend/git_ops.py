from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger("jira_copilot.git")


def _run_git(workspace_path: str, args: list[str], timeout: int = 30) -> dict[str, Any]:
    started_args = ["git", *args]
    try:
        proc = subprocess.run(
            started_args,
            cwd=workspace_path,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        result = {
            "command": " ".join(started_args),
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
        logger.info("git_command", extra={"command": result["command"], "exit_code": proc.returncode})
        return result
    except subprocess.TimeoutExpired as exc:
        logger.error("git_command_timeout", extra={"args": args, "timeout": timeout})
        return {"command": " ".join(started_args), "exit_code": 124, "stdout": exc.stdout or "", "stderr": str(exc)}


def is_git_repo(workspace_path: str) -> bool:
    return _run_git(workspace_path, ["rev-parse", "--is-inside-work-tree"])["exit_code"] == 0


def branch_info(workspace_path: str) -> dict[str, Any]:
    if not is_git_repo(workspace_path):
        return {"is_git_repo": False, "branch": None, "status": None}
    branch = _run_git(workspace_path, ["branch", "--show-current"])
    status = _run_git(workspace_path, ["status", "--short"])
    return {
        "is_git_repo": True,
        "branch": branch["stdout"].strip() or "DETACHED",
        "status": status["stdout"],
    }


def git_diff(workspace_path: str, paths: list[str] | None = None) -> str:
    if not is_git_repo(workspace_path):
        raise RuntimeError("Workspace is not a git repository; cannot generate authoritative git diff")
    args = ["diff", "--"] + (paths or [])
    result = _run_git(workspace_path, args, timeout=60)
    if result["exit_code"] != 0:
        raise RuntimeError(result["stderr"] or "git diff failed")
    return str(result["stdout"])


def git_status(workspace_path: str) -> dict[str, Any]:
    return branch_info(workspace_path)


def commit_changes(workspace_path: str, message: str, paths: list[str] | None = None) -> dict[str, Any]:
    if not is_git_repo(workspace_path):
        return {"ok": False, "error": "Workspace is not a git repository"}
    add_args = ["add", "--"] + (paths or ["."])
    add = _run_git(workspace_path, add_args)
    if add["exit_code"] != 0:
        return {"ok": False, "stage": "add", **add}
    commit = _run_git(workspace_path, ["commit", "-m", message], timeout=120)
    return {"ok": commit["exit_code"] == 0, "stage": "commit", **commit}


def create_branch(workspace_path: str, branch_name: str, checkout: bool = True) -> dict[str, Any]:
    if not is_git_repo(workspace_path):
        return {"ok": False, "error": "Workspace is not a git repository"}
    if not branch_name or any(part in branch_name for part in ["..", "~", "^", ":", "?", "*", "["]):
        return {"ok": False, "error": "Invalid branch name"}
    args = ["checkout", "-b", branch_name] if checkout else ["branch", branch_name]
    result = _run_git(workspace_path, args, timeout=60)
    return {"ok": result["exit_code"] == 0, **result, "branch": branch_name}


def restore_paths(workspace_path: str, paths: list[str], approved: bool = False) -> dict[str, Any]:
    if not approved:
        return {"ok": False, "error": "git_rollback requires approved=true"}
    if not is_git_repo(workspace_path):
        return {"ok": False, "error": "Workspace is not a git repository"}
    safe_paths = [str(ensure_inside(workspace_path, path).relative_to(Path(workspace_path).resolve())) for path in paths]
    result = _run_git(workspace_path, ["restore", "--", *safe_paths], timeout=60)
    return {"ok": result["exit_code"] == 0, **result, "paths": safe_paths}


def ensure_inside(root: str, candidate: str) -> Path:
    root_path = Path(root).resolve()
    full = (root_path / candidate).resolve()
    if full != root_path and root_path not in full.parents:
        raise ValueError(f"Path escapes workspace root: {candidate}")
    return full
