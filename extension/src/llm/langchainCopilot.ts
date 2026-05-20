/**
 * ChatGithubCopilot — LangChain BaseChatModel backed by the GitHub Copilot API.
 *
 * This is the TypeScript equivalent of the Python `langchain-githubcopilot-chat` package
 * (pip install langchain-githubcopilot-chat). It wraps our existing copilotClient.ts so
 * the Copilot LLM can be used with any LangChain chain, agent, or executor.
 */

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelCallOptions, BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import * as vscode from "vscode";
import { resolveSessionToken, copilotChatOnce, streamCopilotChat } from "./copilotClient";
import type { ChatMessage, ChatOptions } from "./copilotClient";

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

export interface ChatGithubCopilotFields extends BaseChatModelParams {
  context: vscode.ExtensionContext;
  temperature?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function baseMessageToChat(msg: BaseMessage): ChatMessage {
  const t = msg._getType();
  const role: "user" | "assistant" | "system" =
    t === "ai" ? "assistant" : t === "system" ? "system" : "user";
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return { role, content };
}

// ---------------------------------------------------------------------------
// ChatGithubCopilot
// ---------------------------------------------------------------------------

export class ChatGithubCopilot extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly _vsContext: vscode.ExtensionContext;
  readonly temperature: number | undefined;
  private readonly _signal: AbortSignal | undefined;

  constructor(fields: ChatGithubCopilotFields) {
    super(fields as BaseChatModelParams);
    this._vsContext = fields.context;
    this.temperature = fields.temperature;
    this._signal = fields.signal;
  }

  _llmType(): string {
    return "github-copilot-chat";
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const sessionToken = await resolveSessionToken(this._vsContext);
    if (!sessionToken) {
      throw new Error(
        "No active GitHub Copilot session. Run \"Code Review: Authenticate Copilot\" first."
      );
    }

    const chatMessages = messages.map(baseMessageToChat);
    const opts: ChatOptions = {
      temperature: this.temperature,
      signal: this._signal,
    };

    const content = await copilotChatOnce(chatMessages, sessionToken, opts);
    const aiMsg = new AIMessage({ content });
    return {
      generations: [{ message: aiMsg, text: content }],
    };
  }

  /**
   * Stream the model response token by token.
   * onChunk receives each text piece as it arrives from the Copilot SSE stream.
   * Returns the full concatenated text when the stream ends.
   */
  async streamGenerate(
    messages: BaseMessage[],
    onChunk: (piece: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const sessionToken = await resolveSessionToken(this._vsContext);
    if (!sessionToken) {
      throw new Error(
        "No active GitHub Copilot session. Run \"Code Review: Authenticate Copilot\" first."
      );
    }

    const chatMessages = messages.map(baseMessageToChat);
    let fullText = "";

    await streamCopilotChat(
      chatMessages,
      sessionToken,
      (line) => {
        if (!line.startsWith("data: ")) return;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
          };
          const piece =
            parsed.choices?.[0]?.delta?.content ??
            parsed.choices?.[0]?.message?.content ??
            "";
          if (piece) {
            fullText += piece;
            onChunk(piece);
          }
        } catch { /* malformed SSE line — ignore */ }
      },
      { temperature: this.temperature, signal: signal ?? this._signal }
    );

    return fullText;
  }
}
