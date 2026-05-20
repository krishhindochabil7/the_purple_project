dev:
	./start_dev.sh

logs:
	tail -f logs/backend.log logs/mcp.log

stop:
	@if [ -f .pids/backend.pid ]; then kill $$(cat .pids/backend.pid) || true; fi
	@if [ -f .pids/mcp.pid ]; then kill $$(cat .pids/mcp.pid) || true; fi
	@echo "Stopped services"

backend:
	.venv_jc/bin/uvicorn main:app --reload --port 8000

mcp:
	.venv_jc/bin/python3 mcp_server.py

test:
	pytest

lint:
	ruff .