"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));

// src/copilotBridge.ts
var http2 = __toESM(require("http"));
var import_url2 = require("url");
var fs2 = __toESM(require("fs/promises"));
var path = __toESM(require("path"));
var vscode2 = __toESM(require("vscode"));

// src/llm/copilotClient.ts
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var tls = __toESM(require("tls"));
var fs = __toESM(require("fs"));
var vscode = __toESM(require("vscode"));
var import_url = require("url");
var SESSION_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
var CHAT_URL = "https://api.githubcopilot.com/chat/completions";
var COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.93.1",
  "Editor-Plugin-Version": "copilot-chat/0.20.3",
  "User-Agent": "GitHubCopilot/1.155.0"
};
function readExtraCa() {
  const p = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS;
  if (!p)
    return void 0;
  try {
    return fs.readFileSync(p);
  } catch {
    return void 0;
  }
}
function collectBody(msg) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    msg.on("data", (c) => chunks.push(c));
    msg.on("end", () => resolve2(Buffer.concat(chunks).toString("utf-8")));
    msg.on("error", reject);
  });
}
async function directRequest(url, method, headers, body) {
  const extraCa = readExtraCa();
  return new Promise((resolve2, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 3e4
    };
    if (extraCa)
      opts.ca = extraCa;
    const req = https.request(opts, (res) => {
      collectBody(res).then(
        (b) => resolve2({ statusCode: res.statusCode ?? 0, headers: res.headers, body: b }),
        reject
      );
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (body)
      req.write(body);
    req.end();
  });
}
async function createConnectTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve2, reject) => {
    const connectHeaders = {
      Host: `${targetHost}:${targetPort}`
    };
    if (proxy.username && proxy.password) {
      const creds = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
      connectHeaders["Proxy-Authorization"] = `Basic ${creds}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: parseInt(proxy.port || "80", 10),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: connectHeaders
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) {
        resolve2(socket);
      } else {
        socket.destroy();
        reject(Object.assign(new Error(`CONNECT failed: ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
      }
    });
    req.on("error", reject);
    req.end();
  });
}
async function proxiedRequest(proxyUrl, url, method, headers, body) {
  const targetPort = parseInt(url.port || "443", 10);
  const rawSocket = await createConnectTunnel(proxyUrl, url.hostname, targetPort);
  const extraCa = readExtraCa();
  const tlsSocket = tls.connect({ socket: rawSocket, servername: url.hostname, ...extraCa ? { ca: extraCa } : {} });
  await new Promise((resolve2, reject) => {
    tlsSocket.once("secureConnect", resolve2);
    tlsSocket.once("error", reject);
  });
  return new Promise((resolve2, reject) => {
    const req = http.request(
      { createConnection: () => tlsSocket, hostname: url.hostname, port: targetPort, path: url.pathname + url.search, method, headers, timeout: 3e4 },
      (res) => {
        collectBody(res).then(
          (b) => resolve2({ statusCode: res.statusCode ?? 0, headers: res.headers, body: b }),
          reject
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxied request timed out"));
    });
    if (body)
      req.write(body);
    req.end();
  });
}
function resolveProxyUrl() {
  const cfg = vscode.workspace.getConfiguration("codeReview");
  return cfg.get("httpsProxy")?.trim() || cfg.get("httpProxy")?.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || void 0;
}
async function requestWithFailsafe(urlStr, method, headers, body) {
  const url = new import_url.URL(urlStr);
  const proxyStr = resolveProxyUrl();
  if (proxyStr) {
    try {
      const proxy = new import_url.URL(proxyStr);
      const resp = await proxiedRequest(proxy, url, method, headers, body);
      if (resp.statusCode !== 407)
        return resp;
    } catch {
    }
  }
  return directRequest(url, method, headers, body);
}
function parseTokenExpiry(raw) {
  for (const part of raw.split(";")) {
    if (part.startsWith("exp=")) {
      const n = parseInt(part.slice(4), 10);
      if (!isNaN(n))
        return n;
    }
  }
  return 0;
}
function isTokenExpired(raw) {
  const exp = parseTokenExpiry(raw);
  return exp > 0 && Date.now() / 1e3 >= exp;
}
async function exchangeSessionToken(accessToken) {
  const resp = await requestWithFailsafe(SESSION_TOKEN_URL, "GET", {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${accessToken}`
  });
  if (resp.statusCode !== 200)
    throw new Error(`Session token exchange failed: ${resp.statusCode} ${resp.body.slice(0, 200)}`);
  const json = JSON.parse(resp.body);
  const token = json.token;
  if (!token)
    throw new Error(`No token in session response: ${resp.body.slice(0, 200)}`);
  return { raw: token, expiry: parseTokenExpiry(token) };
}
async function resolveSessionToken(context) {
  console.log("GLOBAL STATE KEYS");
  console.log(context.globalState.keys());
  const githubSession = await vscode.authentication.getSession(
    "github",
    ["read:user"],
    { createIfNone: true }
  );
  console.log("GITHUB SESSION:", githubSession);
  console.log(githubSession?.accessToken);
  const envSession = process.env.GITHUB_COPILOT_SESSION_ID;
  if (envSession)
    return envSession;
  const storedSession = context.globalState.get("copilot_session_id");
  if (storedSession && !isTokenExpired(storedSession)) {
    return storedSession;
  }
  const accessToken = context.globalState.get("copilot_access_token_override") || context.globalState.get("copilot_access_token") || githubSession?.accessToken || process.env.GITHUB_COPILOT_ACCESS_TOKEN;
  console.log("ACCESS TOKEN EXISTS:", !!accessToken);
  if (!accessToken)
    return null;
  try {
    const result = await exchangeSessionToken(accessToken);
    await context.globalState.update(
      "copilot_session_id",
      result.raw
    );
    return result.raw;
  } catch (e) {
    console.error("TOKEN EXCHANGE FAILED", e);
    return null;
  }
}
function buildChatPayload(messages, opts, stream) {
  return JSON.stringify({
    messages,
    model: opts.model ?? process.env.GITHUB_COPILOT_MODEL ?? "gpt-4o",
    max_tokens: opts.maxTokens ?? parseInt(process.env.GITHUB_COPILOT_MAX_TOKENS ?? "4096", 10),
    temperature: opts.temperature ?? parseFloat(process.env.AGENT_TEMPERATURE ?? "0.1"),
    top_p: 1,
    n: 1,
    stream
  });
}
function buildChatHeaders(sessionToken) {
  return {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${sessionToken}`,
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json"
  };
}
async function copilotChatOnce(messages, sessionToken, opts = {}) {
  const chatUrl = process.env.GITHUB_COPILOT_LLM_CHAT_URL || CHAT_URL;
  const body = buildChatPayload(messages, opts, false);
  const headers = buildChatHeaders(sessionToken);
  const resp = await requestWithFailsafe(chatUrl, "POST", headers, body);
  if (resp.statusCode !== 200) {
    throw new Error(`Copilot chat returned ${resp.statusCode}: ${resp.body.slice(0, 400)}`);
  }
  const json = JSON.parse(resp.body);
  return json.choices?.[0]?.message?.content ?? "";
}

// src/copilotBridge.ts
var HOST = "127.0.0.1";
var PORT = 8001;
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_FILE_BYTES = 96 * 1024;
var REQUEST_TIMEOUT_MS = 12e4;
var IGNORED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "target"]);
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".json",
  ".yaml",
  ".yml",
  ".md"
]);
var bridgeServer;
function log(message, extra) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[JiraCopilot Bridge] ${message}${suffix}`);
}
function isLocalRequest(req) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function hasAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin)
    return true;
  return origin === "http://localhost:8000" || origin === "http://127.0.0.1:8000";
}
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost:8000",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}
function readJsonBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
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
        resolve2(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
async function withTimeout(work, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
function validateWorkspacePath(workspacePath) {
  const root = path.resolve(workspacePath);
  const allowedRoots = vscode2.workspace.workspaceFolders?.map((folder) => path.resolve(folder.uri.fsPath)) ?? [];
  if (!allowedRoots.some((allowed) => root === allowed || root.startsWith(`${allowed}${path.sep}`))) {
    throw new Error("workspacePath must be inside an open VS Code workspace");
  }
  return root;
}
function isSupportedTextFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function looksBinary(buffer) {
  return buffer.includes(0);
}
function scoreFile(filePath, content, query) {
  if (!query.trim())
    return 0;
  const haystack = `${filePath}
${content.slice(0, 6e3)}`.toLowerCase();
  return query.toLowerCase().split(/\W+/).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}
function chunkContent(content) {
  if (content.length <= 24e3)
    return void 0;
  const chunks = [];
  for (let index = 0; index < content.length; index += 24e3) {
    chunks.push(content.slice(index, index + 24e3));
  }
  return chunks;
}
async function collectWorkspaceFiles(root, maxFiles, query) {
  const files = [];
  async function visit(dir) {
    if (files.length >= maxFiles)
      return;
    const entries = await fs2.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles)
        return;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".vscode") {
        if (IGNORED_DIRS.has(entry.name))
          continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name))
          await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSupportedTextFile(fullPath))
        continue;
      const stat2 = await fs2.stat(fullPath);
      if (stat2.size > MAX_FILE_BYTES)
        continue;
      const contentBuffer = await fs2.readFile(fullPath);
      if (looksBinary(contentBuffer))
        continue;
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      const content = contentBuffer.toString("utf-8");
      files.push({
        path: relPath,
        content,
        size: stat2.size,
        chunks: chunkContent(content),
        score: scoreFile(relPath, content, query)
      });
    }
  }
  await visit(root);
  return files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, maxFiles).map(({ score: _score, ...file }) => file);
}
async function repositoryMetadata(root) {
  const entries = await fs2.readdir(root);
  return {
    hasPackageJson: entries.includes("package.json"),
    hasPyproject: entries.includes("pyproject.toml"),
    hasGoMod: entries.includes("go.mod"),
    hasCargoToml: entries.includes("Cargo.toml"),
    hasPomXml: entries.includes("pom.xml"),
    rootName: path.basename(root)
  };
}
async function handleComplete(context, req, res) {
  const started = Date.now();
  const body = await readJsonBody(req);
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
async function handleWorkspaceFiles(req, res) {
  const started = Date.now();
  const body = await readJsonBody(req);
  if (!body.workspacePath) {
    sendJson(res, 400, { error: "workspacePath is required" });
    return;
  }
  const root = validateWorkspacePath(body.workspacePath);
  const maxFiles = Math.max(1, Math.min(body.maxFiles ?? 20, 100));
  const files = await withTimeout(
    collectWorkspaceFiles(root, maxFiles, body.query ?? ""),
    3e4,
    "Workspace scan"
  );
  const repository = await repositoryMetadata(root);
  log("POST /workspace/files completed", { durationMs: Date.now() - started, files: files.length });
  sendJson(res, 200, { files, repository });
}
function startCopilotBridge(context) {
  if (bridgeServer) {
    log("Bridge already running", { port: PORT });
    return new vscode2.Disposable(() => void 0);
  }
  bridgeServer = http2.createServer((req, res) => {
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
      const requestUrl = new import_url2.URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
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
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log("Request failed", { durationMs: Date.now() - started, error: message });
      if (!res.headersSent)
        sendJson(res, 500, { error: message });
    });
  });
  bridgeServer.on("error", (error) => log("Bridge server error", { error: error.message }));
  bridgeServer.listen(PORT, HOST, () => log("Bridge listening", { host: HOST, port: PORT }));
  return new vscode2.Disposable(() => {
    bridgeServer?.close(() => log("Bridge stopped"));
    bridgeServer = void 0;
  });
}

// src/extension.ts
function activate(context) {
  console.log(
    "WORKSPACE:",
    vscode3.workspace.workspaceFolders?.map(
      (f) => f.uri.fsPath
    )
  );
  const bridge = startCopilotBridge(context);
  context.subscriptions.push(bridge);
  const provider = new JiraCopilotProvider(context.extensionUri);
  context.subscriptions.push(
    vscode3.window.registerWebviewViewProvider("jiraCopilot.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}
var JiraCopilotProvider = class {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }
  resolveWebviewView(webviewView) {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode3.Uri.joinPath(this.extensionUri, "dist")]
    };
    const scriptUri = webview.asWebviewUri(vscode3.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const nonce = getNonce();
    const workspacePath = vscode3.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:8000;">
  <title>JiraCopilot</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__JIRA_COPILOT_WORKSPACE_PATH__ = ${JSON.stringify(workspacePath)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "openExternal":
          if (message.url) {
            await vscode3.env.openExternal(
              vscode3.Uri.parse(message.url)
            );
          }
          break;
      }
    });
  }
};
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
