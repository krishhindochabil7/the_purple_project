/**
 * LangChain agent — ChatGithubCopilot model + DynamicTool definitions + streaming.
 *
 * Tool-call format: JSON {"tool_calls":[...]} (not ReAct text).
 * This lets us detect tool calls vs prose in the first 40 chars of the stream,
 * exactly like the original agent, so final answers stream token-by-token while
 * tool-call turns buffer silently.
 *
 * stdout protocol (via onLog) is identical to the previous implementation:
 *   "[Agent] ..."   — diagnostic progress
 *   "data: {...}"   — SSE delta chunk or final message envelope
 */

import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { DynamicTool } from "@langchain/core/tools";
import type { ChatGithubCopilot } from "./langchainCopilot";

// ---------------------------------------------------------------------------
// JSON tool-call detection constants (mirror original chatStreamingWithToolDetect)
// ---------------------------------------------------------------------------

const TOOL_DETECT_WINDOW = 40;
const JSON_TOOL_CALL_RE = /^\{\s*"tool_calls"\s*:/;

// ---------------------------------------------------------------------------
// JSON parsing (mirrors original parseModelJson)
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;

function parseModelJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const s = text.trim();
  try { return JSON.parse(s) as Record<string, unknown>; } catch { /* continue */ }
  const fenceMatch = FENCE_RE.exec(s);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) as Record<string, unknown>; } catch { /* continue */ }
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)) as Record<string, unknown>; } catch { /* continue */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE emission helpers
// ---------------------------------------------------------------------------

function emitDeltaChunk(content: string, onLog: (line: string) => void): void {
  if (content) onLog(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`);
}

function emitFinalMessage(content: string, onLog: (line: string) => void): void {
  onLog(`data: ${JSON.stringify({ choices: [{ message: { content } }] })}`);
}

function emitStreamedText(text: string, onLog: (line: string) => void): void {
  const CHUNK = 48;
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + CHUNK, text.length);
    if (end < text.length) {
      const limit = Math.min(end + CHUNK / 2, text.length);
      let j = end;
      while (j < limit && !/\s/.test(text[j])) j++;
      end = j;
    }
    emitDeltaChunk(text.slice(i, end), onLog);
    i = end;
  }
}

// ---------------------------------------------------------------------------
// Tool system-prompt builder
// ---------------------------------------------------------------------------

function buildToolDocs(tools: DynamicTool[]): string {
  const docs = tools
    .map((t) => `--- ${t.name} ---\n${t.description}`)
    .join("\n\n");

  return (
    `=== AVAILABLE TOOLS ===\n\n` +
    `When you need to investigate the codebase, respond with a SINGLE JSON object:\n\n` +
    `    {"tool_calls": [\n` +
    `      {"name": "<tool_name>", "arguments": { <tool-specific args> }}\n` +
    `    ]}\n\n` +
    `Rules:\n` +
    `- Do NOT wrap the JSON in markdown fences.\n` +
    `- Do NOT add any prose before or after the JSON on a tool-call turn.\n` +
    `- Call tools before producing your final answer.\n` +
    `- When your investigation is complete, reply with plain text / markdown (no JSON).\n\n` +
    docs
  );
}

// ---------------------------------------------------------------------------
// Streaming with JSON tool-call detection
// ---------------------------------------------------------------------------

/**
 * Stream the model response and emit SSE delta chunks for prose turns only.
 *
 * Detection window (first TOOL_DETECT_WINDOW chars):
 *   starts with '{'  + matches JSON_TOOL_CALL_RE → silent_json (buffer, no output)
 *   starts with '{'  + window exhausted w/o match → stream_live
 *   starts with anything else                     → stream_live immediately
 *
 * Returns { fullText, alreadyStreamed } for downstream parsing.
 */
async function streamWithToolDetect(
  llm: ChatGithubCopilot,
  messages: BaseMessage[],
  onLog: (line: string) => void,
  signal?: AbortSignal
): Promise<{ fullText: string; alreadyStreamed: boolean }> {
  let fullText = "";
  let pendingBuffer = "";
  let mode: "undecided" | "silent_json" | "stream_live" = "undecided";

  await llm.streamGenerate(
    messages,
    (piece) => {
      fullText += piece;

      if (mode === "stream_live") {
        emitDeltaChunk(piece, onLog);
        return;
      }
      if (mode === "silent_json") return;

      // undecided — accumulate until we can classify
      pendingBuffer += piece;
      const stripped = pendingBuffer.trimStart();
      if (!stripped) return;

      if (!stripped.startsWith("{")) {
        // Prose response — stream live immediately
        mode = "stream_live";
        emitDeltaChunk(pendingBuffer, onLog);
        pendingBuffer = "";
        return;
      }

      if (JSON_TOOL_CALL_RE.test(stripped)) {
        // Confirmed tool-call JSON — go silent
        mode = "silent_json";
        pendingBuffer = "";
        return;
      }

      if (stripped.length >= TOOL_DETECT_WINDOW) {
        // Window exhausted without matching — treat as prose
        mode = "stream_live";
        emitDeltaChunk(pendingBuffer, onLog);
        pendingBuffer = "";
      }
    },
    signal
  );

  // Flush any buffered content left in undecided state
  if (mode === "undecided" && pendingBuffer) {
    emitDeltaChunk(pendingBuffer, onLog);
    mode = "stream_live";
  }

  return { fullText, alreadyStreamed: mode === "stream_live" };
}

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

async function invokeTool(
  tools: DynamicTool[],
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { error: `unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ")}` };
  }
  // DynamicTool.func expects a plain string; pass single-arg value directly, else JSON
  const input =
    Object.keys(args).length === 1
      ? String(Object.values(args)[0])
      : JSON.stringify(args);
  try {
    return await tool.invoke(input);
  } catch (e) {
    return { error: `${name} failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LangChainAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  llm: ChatGithubCopilot;
  tools: DynamicTool[];
  maxIterations?: number;
  freeform?: boolean;
  signal?: AbortSignal;
  onLog: (line: string) => void;
}

async function dispatchToolCalls(
  tools: DynamicTool[],
  reply: string,
  toolCalls: Array<Record<string, unknown>>,
  messages: BaseMessage[],
  onLog: (line: string) => void
): Promise<void> {
  messages.push(new AIMessage(reply));
  const toolResults: Array<Record<string, unknown>> = [];

  for (const call of toolCalls) {
    const name = (typeof call.name === "string" ? call.name : "").trim();
    const args =
      typeof call.arguments === "object" && call.arguments !== null
        ? (call.arguments as Record<string, unknown>)
        : {};
    const preview = Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ")
      .slice(0, 120);
    onLog(`[Agent] tool → ${name}(${preview})`);
    const result = await invokeTool(tools, name, args);
    toolResults.push({ name, arguments: args, result });
  }

  messages.push(new HumanMessage(JSON.stringify({ tool_results: toolResults })));
}

function emitFinalAnswer(
  finalText: string,
  alreadyStreamed: boolean,
  freeform: boolean,
  onLog: (line: string) => void
): void {
  if (alreadyStreamed) return;
  if (freeform) {
    emitStreamedText(finalText, onLog);
  } else {
    emitFinalMessage(finalText, onLog);
  }
}

export async function runLangChainAgent(opts: LangChainAgentOptions): Promise<void> {
  const {
    systemPrompt,
    userPrompt,
    llm,
    tools,
    maxIterations = 10,
    freeform = false,
    onLog,
  } = opts;

  const fullSystemPrompt = `${systemPrompt}\n\n${buildToolDocs(tools)}`;
  const messages: BaseMessage[] = [
    new SystemMessage(fullSystemPrompt),
    new HumanMessage(userPrompt),
  ];

  onLog("[Agent] ChatGithubCopilot LangChain agent starting…");

  let finalText = "";
  let alreadyStreamed = false;

  for (let iter = 1; iter <= maxIterations; iter++) {
    onLog(`[Agent] iteration ${iter}/${maxIterations} — calling model`);

    let streamResult: { fullText: string; alreadyStreamed: boolean };
    try {
      streamResult = await streamWithToolDetect(llm, messages, onLog, opts.signal);
    } catch (e) {
      emitFinalMessage(`Error: agent call failed (${(e as Error).message})`, onLog);
      return;
    }

    const { fullText: reply, alreadyStreamed: streamed } = streamResult;
    const parsed = parseModelJson(reply);
    const toolCalls = Array.isArray(parsed?.tool_calls)
      ? (parsed.tool_calls as Array<Record<string, unknown>>)
      : null;

    if (toolCalls && toolCalls.length > 0) {
      await dispatchToolCalls(tools, reply, toolCalls, messages, onLog);
      continue;
    }

    onLog(`[Agent] final answer after ${iter} iteration(s)`);
    finalText = reply;
    alreadyStreamed = streamed;
    break;
  }

  emitFinalAnswer(finalText, alreadyStreamed, freeform, onLog);
}
