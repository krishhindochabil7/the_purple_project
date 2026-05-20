The Purple Project

AI-powered Jira copilot for VS Code that analyzes Jira tickets and the current codebase to provide repository-aware implementation guidance and coding assistance with audit trails on each step using a FastAPI + LangGraph backend powered by GitHub Copilot.

## What this demonstrates

- LangGraph stateful graph with human-in-the-loop checkpoints
- Persistent audit trail of every LLM decision
- Selective node retry: reject at any gate and only that node reruns
- Reasoning capture via structured mock responses
- Full session replay with reasoning diffs on retries

## Setup

### Backend

```bash
cd backend
pip install fastapi uvicorn langgraph langgraph-checkpoint-sqlite pydantic
uvicorn main:app --reload --port 8000
```

### Extension

```bash
cd extension
npm install
npm run build
```

Then in VS Code: Run > Start Debugging (F5)

Or package and install the VSIX:

```bash
npm run package
```

Then use Extensions > Install from VSIX.

## No API key needed

All LLM responses are mocked. The full architecture works identically to a real LLM integration. To go live, replace `MockLLM` in `backend/llm_mock.py` with a real model client and keep the graph gates unchanged.

## Architecture

The backend prints the compiled LangGraph ASCII diagram on uvicorn startup. The graph is:

```text
load_context
  -> reason
  -> human_review_reasoning
     -> reason, when rejected
     -> plan, when approved
  -> human_review_plan
     -> plan, when rejected
     -> execute, when approved
  -> human_review_output
     -> execute, when rejected
     -> commit, when approved
  -> END
```

## Notes

- Zero external API calls. `MockLLM` only.
- No API key is required or referenced.
- `reasoning_steps` is append-only through LangGraph list reducers.
- Retry prompts include only the original ticket plus human rejection tag and reason.
- Execution uses `applied_actions` so retries do not duplicate mocked diffs.
- Audit data is persisted through the SQLite LangGraph checkpointer at `backend/audit.db`.
