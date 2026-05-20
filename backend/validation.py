from __future__ import annotations

import ast
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("jira_copilot.validation")


def _run(command: list[str], cwd: str, timeout: int = 120) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        proc = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=timeout, check=False)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        result = {
            "command": " ".join(command),
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-12000:],
            "stderr": proc.stderr[-12000:],
            "elapsed_ms": elapsed_ms,
        }
        logger.info("validation_command", extra={"command": result["command"], "exit_code": proc.returncode, "elapsed_ms": elapsed_ms})
        return result
    except FileNotFoundError as exc:
        return {"command": " ".join(command), "exit_code": 127, "stdout": "", "stderr": str(exc), "elapsed_ms": 0}
    except subprocess.TimeoutExpired as exc:
        return {"command": " ".join(command), "exit_code": 124, "stdout": exc.stdout or "", "stderr": str(exc), "elapsed_ms": timeout * 1000}


def validate_python_syntax(path: Path, content: str) -> dict[str, Any]:
    try:
        ast.parse(content, filename=str(path))
        return {"ok": True, "path": str(path), "error": None}
    except SyntaxError as exc:
        return {"ok": False, "path": str(path), "error": f"{exc.msg} at line {exc.lineno}:{exc.offset}"}


def prewrite_validate(path: Path, content: str) -> dict[str, Any]:
    if path.suffix == ".py":
        return validate_python_syntax(path, content)
    if path.suffix in {".json"}:
        try:
            json.loads(content)
            return {"ok": True, "path": str(path), "error": None}
        except json.JSONDecodeError as exc:
            return {"ok": False, "path": str(path), "error": str(exc)}
    return {"ok": True, "path": str(path), "error": None}


def detect_validation_commands(workspace_path: str) -> list[list[str]]:
    root = Path(workspace_path)
    commands: list[list[str]] = []
    package_json = root / "package.json"
    if package_json.exists():
        try:
            scripts = json.loads(package_json.read_text()).get("scripts", {})
        except json.JSONDecodeError:
            scripts = {}
        for script in ["lint", "typecheck", "test", "build"]:
            if script in scripts:
                commands.append(["npm", "run", script])
    if any((root / name).exists() for name in ["pyproject.toml", "pytest.ini", "setup.cfg", "requirements.txt"]):
        commands.append(["python3", "-m", "pytest"])
    if (root / "go.mod").exists():
        commands.append(["go", "test", "./..."])
    if (root / "pom.xml").exists():
        commands.append(["mvn", "test"])
    if (root / "build.gradle").exists() or (root / "build.gradle.kts").exists():
        commands.append(["./gradlew", "test"] if (root / "gradlew").exists() else ["gradle", "test"])
    if (root / "Cargo.toml").exists():
        commands.append(["cargo", "test"])
    return commands


def run_validation(workspace_path: str) -> dict[str, Any]:
    commands = detect_validation_commands(workspace_path)
    if not commands:
        logger.info("validation_skipped", extra={"reason": "no_commands_detected"})
        return {"ok": True, "skipped": True, "reason": "No validation commands detected", "commands": []}
    results = [_run(command, workspace_path) for command in commands]
    ok = all(result["exit_code"] == 0 for result in results)
    return {"ok": ok, "skipped": False, "commands": results}
