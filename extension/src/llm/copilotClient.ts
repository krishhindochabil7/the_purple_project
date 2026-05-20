/**
 * Copilot HTTP client — pure TypeScript replacement for python/copilot_client.py.
 *
 * Handles:
 *   - GitHub OAuth device-code flow
 *   - Session-token exchange (api.github.com/copilot_internal/v2/token)
 *   - Streaming + non-streaming chat completions (api.githubcopilot.com)
 *   - Proxy failsafe: tries configured proxy first, retries direct on 407 / connection error
 *   - SSL CA injection via SSL_CERT_FILE / NODE_EXTRA_CA_CERTS env vars
 */

import * as http from "http";
import * as https from "https";
import * as tls from "tls";
import * as fs from "fs";
import * as vscode from "vscode";
import { URL } from "url";
import { clearGithubUserProfile, setGithubUserProfile, type GithubUserProfile } from "../utils/githubUserState";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLIENT_ID = "iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const SESSION_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.93.1",
  "Editor-Plugin-Version": "copilot-chat/0.20.3",
  "User-Agent": "GitHubCopilot/1.155.0",
};

// ---------------------------------------------------------------------------
// Low-level HTTP with proxy-CONNECT failsafe
// ---------------------------------------------------------------------------

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StreamRawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  message: http.IncomingMessage;
}

function readExtraCa(): Buffer | undefined {
  const p = process.env.SSL_CERT_FILE || process.env.NODE_EXTRA_CA_CERTS;
  if (!p) return undefined;
  try {
    return fs.readFileSync(p);
  } catch {
    return undefined;
  }
}

function collectBody(msg: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    msg.on("data", (c: Buffer) => chunks.push(c));
    msg.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    msg.on("error", reject);
  });
}

async function directRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<RawResponse> {
  const extraCa = readExtraCa();
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 30000,
    };
    if (extraCa) opts.ca = extraCa;
    const req = https.request(opts, (res) => {
      collectBody(res).then(
        (b) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: b }),
        reject
      );
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

async function directStreamRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<StreamRawResponse> {
  const extraCa = readExtraCa();
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 120000,
    };
    if (extraCa) opts.ca = extraCa;
    const req = https.request(opts, (res) => {
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, message: res });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Stream request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

async function createConnectTunnel(proxy: URL, targetHost: string, targetPort: number): Promise<http.IncomingMessage["socket"]> {
  return new Promise((resolve, reject) => {
    const connectHeaders: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
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
      headers: connectHeaders,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(Object.assign(new Error(`CONNECT failed: ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
      }
    });
    req.on("error", reject);
    req.end();
  });
}

async function proxiedRequest(
  proxyUrl: URL,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<RawResponse> {
  const targetPort = parseInt(url.port || "443", 10);
  const rawSocket = await createConnectTunnel(proxyUrl, url.hostname, targetPort);
  const extraCa = readExtraCa();
  const tlsSocket = tls.connect({ socket: rawSocket as tls.ConnectionOptions["socket"], servername: url.hostname, ...(extraCa ? { ca: extraCa } : {}) });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { createConnection: () => tlsSocket, hostname: url.hostname, port: targetPort, path: url.pathname + url.search, method, headers, timeout: 30000 },
      (res) => {
        collectBody(res).then(
          (b) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: b }),
          reject
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxied request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

async function proxiedStreamRequest(
  proxyUrl: URL,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<StreamRawResponse> {
  const targetPort = parseInt(url.port || "443", 10);
  const rawSocket = await createConnectTunnel(proxyUrl, url.hostname, targetPort);
  const extraCa = readExtraCa();
  const tlsSocket = tls.connect({ socket: rawSocket as tls.ConnectionOptions["socket"], servername: url.hostname, ...(extraCa ? { ca: extraCa } : {}) });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { createConnection: () => tlsSocket, hostname: url.hostname, port: targetPort, path: url.pathname + url.search, method, headers, timeout: 120000 },
      (res) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, message: res })
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxied stream request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

function resolveProxyUrl(): string | undefined {
  const cfg = vscode.workspace.getConfiguration("codeReview");
  return (
    cfg.get<string>("httpsProxy")?.trim() ||
    cfg.get<string>("httpProxy")?.trim() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

async function requestWithFailsafe(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<RawResponse> {
  const url = new URL(urlStr);
  const proxyStr = resolveProxyUrl();
  if (proxyStr) {
    try {
      const proxy = new URL(proxyStr);
      const resp = await proxiedRequest(proxy, url, method, headers, body);
      if (resp.statusCode !== 407) return resp;
    } catch {
      // proxy unavailable — fall through to direct
    }
  }
  return directRequest(url, method, headers, body);
}

async function streamWithFailsafe(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<StreamRawResponse> {
  const url = new URL(urlStr);
  const proxyStr = resolveProxyUrl();
  if (proxyStr) {
    try {
      const proxy = new URL(proxyStr);
      const resp = await proxiedStreamRequest(proxy, url, method, headers, body);
      if (resp.statusCode !== 407) return resp;
    } catch {
      // proxy unavailable — fall through to direct
    }
  }
  return directStreamRequest(url, method, headers, body);
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function parseTokenExpiry(raw: string): number {
  for (const part of raw.split(";")) {
    if (part.startsWith("exp=")) {
      const n = parseInt(part.slice(4), 10);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function isTokenExpired(raw: string): boolean {
  const exp = parseTokenExpiry(raw);
  return exp > 0 && Date.now() / 1000 >= exp;
}

function encodeForm(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

// ---------------------------------------------------------------------------
// OAuth device flow
// ---------------------------------------------------------------------------

export interface DeviceCodeResult {
  deviceCode: string;
  userCode: string;
}

export async function getDeviceCode(): Promise<DeviceCodeResult> {
  const body = encodeForm({
    client_id: process.env.GITHUB_COPILOT_CLIENT_ID || DEFAULT_CLIENT_ID,
    scope: "read:user user:email",
  });
  const resp = await requestWithFailsafe(DEVICE_CODE_URL, "POST", {
    ...COPILOT_HEADERS,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  }, body);
  if (resp.statusCode !== 200) throw new Error(`Device code request failed: ${resp.statusCode}`);
  const json = JSON.parse(resp.body) as Record<string, string>;
  if (!json.device_code) throw new Error(`No device_code in response: ${resp.body}`);
  return { deviceCode: json.device_code, userCode: json.user_code };
}

export async function pollForAccessToken(
  deviceCode: string,
  onStatus: (msg: string) => void
): Promise<string> {
  let interval = 5;
  const grantType = "urn:ietf:params:oauth:grant-type:device_code";

  while (true) {
    const body = encodeForm({
      client_id: process.env.GITHUB_COPILOT_CLIENT_ID || DEFAULT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: grantType,
    });
    const resp = await requestWithFailsafe(ACCESS_TOKEN_URL, "POST", {
      ...COPILOT_HEADERS,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    }, body);

    const json = JSON.parse(resp.body) as Record<string, string>;
    const error = json.error;

    if (json.access_token) {
      onStatus("Success");
      return json.access_token;
    }
    if (error === "authorization_pending") {
      onStatus("Waiting for authorization...");
    } else if (error === "slow_down") {
      interval += 5;
      onStatus(`Slow down requested... (Waiting ${interval}s)`);
    } else if (error) {
      throw new Error(`Auth error: ${error} — ${json.error_description || ""}`);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

export interface SessionTokenResult {
  raw: string;
  expiry: number;
}

export async function exchangeSessionToken(accessToken: string): Promise<SessionTokenResult> {
  const resp = await requestWithFailsafe(SESSION_TOKEN_URL, "GET", {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${accessToken}`,
  });
  if (resp.statusCode !== 200) throw new Error(`Session token exchange failed: ${resp.statusCode} ${resp.body.slice(0, 200)}`);
  const json = JSON.parse(resp.body) as Record<string, string>;
  const token = json.token;
  if (!token) throw new Error(`No token in session response: ${resp.body.slice(0, 200)}`);
  return { raw: token, expiry: parseTokenExpiry(token) };
}

// ---------------------------------------------------------------------------
// GitHub user profile
// ---------------------------------------------------------------------------

export async function fetchGithubUserProfile(accessToken: string): Promise<GithubUserProfile | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "GitHubCopilot/1.155.0",
  };
  try {
    const resp = await requestWithFailsafe(GITHUB_USER_URL, "GET", headers);
    if (resp.statusCode !== 200) return null;
    const u = JSON.parse(resp.body) as Record<string, unknown>;
    let email = typeof u.email === "string" ? u.email : "";
    if (!email) {
      try {
        const r2 = await requestWithFailsafe(GITHUB_EMAILS_URL, "GET", headers);
        if (r2.statusCode === 200) {
          const emails = JSON.parse(r2.body) as Array<{ primary?: boolean; verified?: boolean; email?: string }>;
          const primary = emails.find((e) => e.primary && e.verified);
          email = primary?.email ?? "";
        }
      } catch { /* ignore */ }
    }
    return {
      id: u.id != null ? String(u.id) : "",
      login: typeof u.login === "string" ? u.login : "",
      name: typeof u.name === "string" ? u.name : "",
      email,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session resolution (mirrors agent_client._resolve_session_token)
// ---------------------------------------------------------------------------

// export async function resolveSessionToken(context: vscode.ExtensionContext): Promise<string | null> {
//   console.log("GLOBAL STATE KEYS");
//   console.log(context.globalState.keys());
//   const envSession = process.env.GITHUB_COPILOT_SESSION_ID;
//   if (envSession) return envSession;

//   const storedSession = context.globalState.get<string>("copilot_session_id");
//   if (storedSession && !isTokenExpired(storedSession)) return storedSession;

//   const accessToken =
//     context.globalState.get<string>("copilot_access_token_override") ||
//     context.globalState.get<string>("copilot_access_token") ||
//     process.env.GITHUB_COPILOT_ACCESS_TOKEN;
//   if (!accessToken) return null;

//   try {
//     const result = await exchangeSessionToken(accessToken);
//     await context.globalState.update("copilot_session_id", result.raw);
//     return result.raw;
//   } catch {
//     return null;
//   }
// }

export async function resolveSessionToken(
  context: vscode.ExtensionContext
): Promise<string | null> {

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
  if (envSession) return envSession;

  const storedSession =
    context.globalState.get<string>("copilot_session_id");

  if (storedSession && !isTokenExpired(storedSession)) {
    return storedSession;
  }

  const accessToken =
    context.globalState.get<string>("copilot_access_token_override") ||
    context.globalState.get<string>("copilot_access_token") ||
    githubSession?.accessToken ||
    process.env.GITHUB_COPILOT_ACCESS_TOKEN;

  console.log("ACCESS TOKEN EXISTS:", !!accessToken);

  if (!accessToken) return null;

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

// ---------------------------------------------------------------------------
// Chat completions — streaming
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

function buildChatPayload(messages: ChatMessage[], opts: ChatOptions, stream: boolean): string {
  return JSON.stringify({
    messages,
    model: opts.model ?? process.env.GITHUB_COPILOT_MODEL ?? "gpt-4o",
    max_tokens: opts.maxTokens ?? parseInt(process.env.GITHUB_COPILOT_MAX_TOKENS ?? "4096", 10),
    temperature: opts.temperature ?? parseFloat(process.env.AGENT_TEMPERATURE ?? "0.1"),
    top_p: 1,
    n: 1,
    stream,
  });
}

function buildChatHeaders(sessionToken: string): Record<string, string> {
  return {
    ...COPILOT_HEADERS,
    Authorization: `Bearer ${sessionToken}`,
    "Accept-Encoding": "gzip, deflate, br",
    "Content-Type": "application/json",
  };
}

/** Stream chat completions. Calls onData with each "data: {...}" SSE line (same format as Python stdout). */
export async function streamCopilotChat(
  messages: ChatMessage[],
  sessionToken: string,
  onData: (line: string) => void,
  opts: ChatOptions = {}
): Promise<void> {
  const chatUrl = process.env.GITHUB_COPILOT_LLM_CHAT_URL || CHAT_URL;
  const body = buildChatPayload(messages, opts, true);
  const headers = buildChatHeaders(sessionToken);

  const resp = await streamWithFailsafe(chatUrl, "POST", headers, body);
  if (resp.statusCode !== 200) {
    const errBody = await collectBody(resp.message);
    const snippet = errBody.replace(/\r?\n/g, " ").slice(0, 400);
    onData(`data: ${JSON.stringify({ choices: [{ delta: { content: `Error ${resp.statusCode}: ${snippet}` } }] })}`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resp.message.destroy();
      reject(new Error("Cancelled by user"));
      return;
    }
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      resp.message.destroy();
      reject(new Error("Cancelled by user"));
    };
    opts.signal?.addEventListener("abort", onAbort);

    let buf = "";
    resp.message.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith("data: ")) onData(l);
      }
    });
    resp.message.on("end", () => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    resp.message.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (!cancelled) reject(e);
    });
  });
}

/** Non-streaming chat — returns the full assistant message content. */
export async function copilotChatOnce(
  messages: ChatMessage[],
  sessionToken: string,
  opts: ChatOptions = {}
): Promise<string> {
  const chatUrl = process.env.GITHUB_COPILOT_LLM_CHAT_URL || CHAT_URL;
  const body = buildChatPayload(messages, opts, false);
  const headers = buildChatHeaders(sessionToken);

  const resp = await requestWithFailsafe(chatUrl, "POST", headers, body);
  if (resp.statusCode !== 200) {
    throw new Error(`Copilot chat returned ${resp.statusCode}: ${resp.body.slice(0, 400)}`);
  }
  const json = JSON.parse(resp.body) as { choices: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Full device-code auth flow (replaces copilot_client.py --authenticate)
// ---------------------------------------------------------------------------

export interface AuthFlowCallbacks {
  onAuthRequired: (verificationUrl: string, userCode: string) => void;
  onPollingStatus?: (status: string) => void;
  onSessionStored?: () => void;
  onAuthSuccess: () => void;
}

export async function runDeviceAuthFlow(
  context: vscode.ExtensionContext,
  onLog: (line: string) => void,
  callbacks: AuthFlowCallbacks
): Promise<void> {
  onLog(">>> Starting device sign-in…");

  const { deviceCode, userCode } = await getDeviceCode();
  callbacks.onAuthRequired("https://github.com/login/device", userCode);

  const accessToken = await pollForAccessToken(deviceCode, (status) => {
    onLog(`POLLING_STATUS|${status}`);
    callbacks.onPollingStatus?.(status);
  });

  await context.globalState.update("copilot_access_token", accessToken);

  const profile = await fetchGithubUserProfile(accessToken);
  if (profile) {
    onLog(`GITHUB_USER|${JSON.stringify(profile)}`);
    await setGithubUserProfile(context, profile);
  }

  const sessionResult = await exchangeSessionToken(accessToken);
  await context.globalState.update("copilot_session_id", sessionResult.raw);
  onLog(`SESSION_ID|${sessionResult.raw}`);
  callbacks.onSessionStored?.();

  onLog("AUTH_SUCCESS");
  callbacks.onAuthSuccess();
}

// ---------------------------------------------------------------------------
// Wipe stored tokens (called on auth failure)
// ---------------------------------------------------------------------------

export async function clearStoredTokens(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update("copilot_session_id", undefined);
  await context.globalState.update("copilot_access_token_override", undefined);
  await clearGithubUserProfile(context);
}
