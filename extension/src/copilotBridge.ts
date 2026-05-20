import * as http from "http";
import { URL } from "url";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import {
  copilotChatOnce,
  resolveSessionToken,
  type ChatMessage
} from "./llm/copilotClient";

const HOST = "127.0.0.1";
const PORT = 8001;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 96 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target"]);
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".json", ".yaml", ".yml", ".md"
]);

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
  chunks?: string[];
}

let bridgeServer: http.Server | undefined;

function log(message: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[JiraCopilot Bridge] ${message}${suffix}`);
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === "http://localhost:8000" || origin === "http://127.0.0.1:8000";
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost:8000",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateWorkspacePath(workspacePath: string): string {
  const root = path.resolve(workspacePath);
  const allowedRoots = vscode.workspace.workspaceFolders?.map((folder) => path.resolve(folder.uri.fsPath)) ?? [];
  if (!allowedRoots.some((allowed) => root === allowed || root.startsWith(`${allowed}${path.sep}`))) {
    throw new Error("workspacePath must be inside an open VS Code workspace");
  }
  return root;
}

function isSupportedTextFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function scoreFile(filePath: string, content: string, query: string): number {
  if (!query.trim()) return 0;
  const haystack = `${filePath}\n${content.slice(0, 6000)}`.toLowerCase();
  return query.toLowerCase().split(/\W+/).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function chunkContent(content: string): string[] | undefined {
  if (content.length <= 24000) return undefined;
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 24000) {
    chunks.push(content.slice(index, index + 24000));
  }
  return chunks;
}

async function collectWorkspaceFiles(root: string, maxFiles: number, query: string): Promise<WorkspaceFile[]> {
  const files: Array<WorkspaceFile & { score: number }> = [];

  async function visit(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".vscode") {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSupportedTextFile(fullPath)) continue;
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_BYTES) continue;
      const contentBuffer = await fs.readFile(fullPath);
      if (looksBinary(contentBuffer)) continue;
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const content = contentBuffer.toString("utf-8");
      files.push({
        path: relPath,
        content,
        size: stat.size,
        chunks: chunkContent(content),
        score: scoreFile(relPath, content, query)
      });
    }
  }

  await visit(root);
  return files
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles)
    .map(({ score: _score, ...file }) => file);
}

async function repositoryMetadata(root: string): Promise<Record<string, unknown>> {
  const entries = await fs.readdir(root);
  return {
    hasPackageJson: entries.includes("package.json"),
    hasPyproject: entries.includes("pyproject.toml"),
    hasGoMod: entries.includes("go.mod"),
    hasCargoToml: entries.includes("Cargo.toml"),
    hasPomXml: entries.includes("pom.xml"),
    rootName: path.basename(root)
  };
}

async function handleComplete(context: vscode.ExtensionContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const started = Date.now();
  const body = await readJsonBody<{ messages?: ChatMessage[] }>(req);
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    sendJson(res, 400, { error: "messages must be a non-empty array" });
    return;
  }

  const sessionToken = await resolveSessionToken(context);
  if (!sessionToken) {
    throw new Error("No active GitHub Copilot session. Authenticate Copilot in VS Code first.");
  }

  const content = await withTimeout(
    copilotChatOnce(messages, sessionToken, { temperature: 0.1 }),
    REQUEST_TIMEOUT_MS,
    "Copilot completion"
  );
  log("POST /copilot/complete completed", { durationMs: Date.now() - started });
  sendJson(res, 200, { content });
}

async function handleWorkspaceFiles(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const started = Date.now();
  const body = await readJsonBody<{ workspacePath?: string; maxFiles?: number; query?: string }>(req);
  if (!body.workspacePath) {
    sendJson(res, 400, { error: "workspacePath is required" });
    return;
  }
  const root = validateWorkspacePath(body.workspacePath);
  const maxFiles = Math.max(1, Math.min(body.maxFiles ?? 20, 100));
  const files = await withTimeout(
    collectWorkspaceFiles(root, maxFiles, body.query ?? ""),
    30000,
    "Workspace scan"
  );
  const repository = await repositoryMetadata(root);
  log("POST /workspace/files completed", { durationMs: Date.now() - started, files: files.length });
  sendJson(res, 200, { files, repository });
}

export function startCopilotBridge(context: vscode.ExtensionContext): vscode.Disposable {
  if (bridgeServer) {
    log("Bridge already running", { port: PORT });
    return new vscode.Disposable(() => undefined);
  }

  bridgeServer = http.createServer((req, res) => {
    const started = Date.now();
    void (async () => {
      if (!isLocalRequest(req) || !hasAllowedOrigin(req)) {
        sendJson(res, 403, { error: "Localhost access only" });
        return;
      }
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
      log(`${req.method ?? "GET"} ${requestUrl.pathname}`, { remoteAddress: req.socket.remoteAddress });

      if (req.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/copilot/complete") {
        await handleComplete(context, req, res);
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/workspace/files") {
        await handleWorkspaceFiles(req, res);
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log("Request failed", { durationMs: Date.now() - started, error: message });
      if (!res.headersSent) sendJson(res, 500, { error: message });
    });
  });

  bridgeServer.on("error", (error) => log("Bridge server error", { error: error.message }));
  bridgeServer.listen(PORT, HOST, () => log("Bridge listening", { host: HOST, port: PORT }));

  return new vscode.Disposable(() => {
    bridgeServer?.close(() => log("Bridge stopped"));
    bridgeServer = undefined;
  });
}
