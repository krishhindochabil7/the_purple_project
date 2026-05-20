/**
 * LangChain DynamicTool wrappers around the sandboxed workspace tools in agentTools.ts.
 *
 * Each tool accepts either a plain string or a JSON string as input — the func
 * normalises both cases before delegating to dispatch().
 */

import { DynamicTool } from "@langchain/core/tools";
import { dispatch } from "./agentTools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOrString(raw: string, plainKey: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { [plainKey]: raw.trim() };
  }
}

function toolResult(result: Record<string, unknown>): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWorkspaceTools(workspaceRoot: string): DynamicTool[] {
  return [
    new DynamicTool({
      name: "read_file",
      description:
        "Read a workspace-relative text file. " +
        'Input: plain relative path (e.g. "src/main.ts") or JSON {"path":"...","max_bytes":<int>}.',
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "path");
        return toolResult(dispatch(workspaceRoot, "read_file", args));
      },
    }),

    new DynamicTool({
      name: "read_file_lines",
      description:
        "Read a specific line range of a file without loading the whole file. " +
        'Input JSON: {"path":"src/foo.ts","start_line":10,"end_line":60}. ' +
        "Lines are 1-based. Defaults: start=1, end=start+199. " +
        "Returns line-numbered content and total_lines so you can page through large files.",
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "path");
        return toolResult(dispatch(workspaceRoot, "read_file_lines", args));
      },
    }),

    new DynamicTool({
      name: "list_directory",
      description:
        "List the immediate contents (files and subdirectories) of a directory. " +
        'Input: plain directory path (e.g. "src/commands") or JSON {"path":"..."}. ' +
        "Use this to explore project structure before grepping blindly.",
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "path");
        return toolResult(dispatch(workspaceRoot, "list_directory", args));
      },
    }),

    new DynamicTool({
      name: "grep_codebase",
      description:
        "Regex search across all workspace text files. " +
        'Input JSON: {"pattern":"<js-regex>","glob":"<optional glob>","max_results":<int>}. ' +
        "Or a plain regex pattern string. Skips node_modules, .git, build, dist, out.",
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "pattern");
        return toolResult(dispatch(workspaceRoot, "grep_codebase", args));
      },
    }),

    new DynamicTool({
      name: "list_workspace_files",
      description:
        "List all workspace files matching a glob pattern. " +
        'Input JSON: {"glob":"**/*.ts","max_results":<int>} or empty string for all files.',
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "glob");
        return toolResult(dispatch(workspaceRoot, "list_workspace_files", args));
      },
    }),

    new DynamicTool({
      name: "find_definitions",
      description:
        "Find where a function, class, interface, type, enum, or variable is *defined* " +
        "(not just used). Much faster than grep for locating declaration sites. " +
        'Input: plain symbol name (e.g. "RepoDocPanel") or JSON {"name":"...","glob":"**/*.ts"}.',
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "name");
        return toolResult(dispatch(workspaceRoot, "find_definitions", args));
      },
    }),

    new DynamicTool({
      name: "list_imports_and_usages",
      description:
        "Find every import statement and usage site of a named symbol across the workspace. " +
        "Use this to understand how a class or function is wired together. " +
        'Input: plain symbol identifier (e.g. "GeniePanelHost") or JSON {"symbol":"..."}.',
      func: async (input: string): Promise<string> => {
        const args = jsonOrString(input, "symbol");
        return toolResult(dispatch(workspaceRoot, "list_imports_and_usages", args));
      },
    }),
  ];
}
