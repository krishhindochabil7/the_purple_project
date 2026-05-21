/**
 * LLM Provider — type definitions and helpers for selecting between
 * GitHub Copilot and Claude agent SDK.
 *
 * The user picks their provider in the webview before starting a session.
 * The choice is sent to the backend alongside the ticket & workspace path.
 */

export type LLMProvider = "copilot" | "claude";

export const LLM_PROVIDERS: LLMProvider[] = ["copilot", "claude"];

export function isLLMProvider(value: string): value is LLMProvider {
  return value === "copilot" || value === "claude";
}

export function llmProviderLabel(provider: LLMProvider): string {
  switch (provider) {
    case "copilot": return "GitHub Copilot";
    case "claude":  return "Claude (Agent SDK)";
  }
}

export function llmProviderDescription(provider: LLMProvider): string {
  switch (provider) {
    case "copilot":
      return "Uses GitHub Copilot via the VS Code session. Works best when you have an active GitHub Copilot subscription.";
    case "claude":
      return "Uses the Claude Agent SDK to analyze code. Requires Anthropic API key configured.";
  }
}
