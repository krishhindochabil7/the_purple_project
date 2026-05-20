import * as fs from "fs";
import * as path from "path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "build", "dist", "out", ".next", "coverage"]);
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".json", ".yaml", ".yml", ".md", ".txt"]);

type Args = Record<string, unknown>;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath || ".");
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walk(root: string, maxResults: number, predicate: (filePath: string) => boolean): string[] {
  const results: string[] = [];
  function visit(dir: string): void {
    if (results.length >= maxResults) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= maxResults) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  visit(root);
  return results;
}

function readFile(root: string, args: Args): Record<string, unknown> {
  const filePath = safePath(root, asString(args.path));
  const maxBytes = asNumber(args.max_bytes, 100000);
  const content = fs.readFileSync(filePath);
  return { path: path.relative(root, filePath), content: content.subarray(0, maxBytes).toString("utf-8"), truncated: content.length > maxBytes };
}

function readFileLines(root: string, args: Args): Record<string, unknown> {
  const filePath = safePath(root, asString(args.path));
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const start = Math.max(1, Math.floor(asNumber(args.start_line, 1)));
  const end = Math.min(lines.length, Math.floor(asNumber(args.end_line, start + 199)));
  return {
    path: path.relative(root, filePath),
    start_line: start,
    end_line: end,
    total_lines: lines.length,
    content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
  };
}

function listDirectory(root: string, args: Args): Record<string, unknown> {
  const dir = safePath(root, asString(args.path, "."));
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
  return { path: path.relative(root, dir) || ".", entries };
}

function listWorkspaceFiles(root: string, args: Args): Record<string, unknown> {
  const maxResults = Math.floor(asNumber(args.max_results, 200));
  const files = walk(root, maxResults, isTextFile).map((filePath) => path.relative(root, filePath));
  return { files };
}

function grepCodebase(root: string, args: Args): Record<string, unknown> {
  const pattern = asString(args.pattern);
  const maxResults = Math.floor(asNumber(args.max_results, 100));
  const regex = new RegExp(pattern, "i");
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const filePath of walk(root, 1000, isTextFile)) {
    if (matches.length >= maxResults) break;
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length < maxResults && regex.test(line)) {
        matches.push({ path: path.relative(root, filePath), line: index + 1, text: line });
      }
    });
  }
  return { matches };
}

function findDefinitions(root: string, args: Args): Record<string, unknown> {
  const name = asString(args.name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `(?:class|function|interface|type|enum|const|let|var|def)\\s+${escaped}\\b`;
  return grepCodebase(root, { pattern, max_results: args.max_results ?? 100 });
}

function listImportsAndUsages(root: string, args: Args): Record<string, unknown> {
  const symbol = asString(args.symbol);
  return grepCodebase(root, { pattern: `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, max_results: args.max_results ?? 100 });
}

export function dispatch(workspaceRoot: string, action: string, args: Args): Record<string, unknown> {
  switch (action) {
    case "read_file": return readFile(workspaceRoot, args);
    case "read_file_lines": return readFileLines(workspaceRoot, args);
    case "list_directory": return listDirectory(workspaceRoot, args);
    case "grep_codebase": return grepCodebase(workspaceRoot, args);
    case "list_workspace_files": return listWorkspaceFiles(workspaceRoot, args);
    case "find_definitions": return findDefinitions(workspaceRoot, args);
    case "list_imports_and_usages": return listImportsAndUsages(workspaceRoot, args);
    default: return { error: `Unknown action ${action}` };
  }
}
