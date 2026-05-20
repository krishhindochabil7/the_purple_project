#!/usr/bin/env bash

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_DIR="$ROOT_DIR/.pids"

mkdir -p "$LOG_DIR"
mkdir -p "$PID_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_warn() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

echo "Starting JiraCopilot MCP Runtime..."

cd "$ROOT_DIR"

# -----------------------------
# VENV SETUP
# -----------------------------
if [ ! -d ".venv_jc" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv_jc
fi

source .venv_jc/bin/activate

# -----------------------------
# DEPENDENCIES
# -----------------------------
echo "Installing dependencies..."
pip install -r requirements.txt

# -----------------------------
# ENV VALIDATION
# -----------------------------
if [ ! -f ".env" ]; then
  print_error ".env file missing"
  exit 1
fi

source .env

if [[ -z "$JIRA_CLIENT_ID" && -z "$JIRA_API_TOKEN" ]]; then
  print_error "No Jira auth configured in .env"
  exit 1
fi

print_success "Environment validated"

# -----------------------------
# SQLITE CHECK
# -----------------------------
touch audit.db

python3 - <<EOF
import sqlite3
conn = sqlite3.connect("audit.db")
conn.execute("PRAGMA journal_mode=WAL;")
conn.commit()
conn.close()
EOF

print_success "SQLite initialized with WAL mode"

# -----------------------------
# START FASTAPI
# -----------------------------
echo "Starting FastAPI backend..."

nohup .venv_jc/bin/uvicorn main:app --reload --port 8000 \
  > "$LOG_DIR/backend.log" 2>&1 &

BACKEND_PID=$!

echo $BACKEND_PID > "$PID_DIR/backend.pid"

sleep 3

if ps -p $BACKEND_PID > /dev/null; then
  print_success "FastAPI backend running on :8000"
else
  print_error "Failed to start FastAPI backend"
  exit 1
fi

# -----------------------------
# COPILOT BRIDGE CHECK
# -----------------------------
if curl -s http://localhost:8001/health > /dev/null; then
  print_success "Copilot bridge reachable"
else
  print_warn "Copilot bridge not reachable (start VS Code extension with F5)"
fi

# -----------------------------
# CLEANUP
# -----------------------------
cleanup() {
  echo ""
  echo "Stopping services..."

  if [ -f "$PID_DIR/backend.pid" ]; then
    kill $(cat "$PID_DIR/backend.pid") 2>/dev/null || true
  fi

  print_success "Services stopped"
}

trap cleanup EXIT INT TERM

echo ""
print_success "JiraCopilot runtime started successfully"
echo ""
echo "Logs:"
echo "  Backend: $LOG_DIR/backend.log"
echo "  MCP:     $LOG_DIR/mcp.log"
echo ""

wait