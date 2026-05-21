import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
declare function acquireVsCodeApi(): {
  postMessage: (message: any) => void;
};

const API = "http://localhost:8000";
const vscode = acquireVsCodeApi();

declare global {
  interface Window {
    __JIRA_COPILOT_WORKSPACE_PATH__?: string;
  }
}
const tags = ["WRONG_APPROACH", "TOO_RISKY", "MISREAD_REQUIREMENT", "INCOMPLETE", "OTHER"];

type LLMProvider = "copilot" | "claude";

const LLM_PROVIDERS: { value: LLMProvider; label: string; desc: string }[] = [
  { value: "copilot", label: "GitHub Copilot", desc: "Uses GitHub Copilot via your VS Code session." },
  { value: "claude", label: "Claude (Agent SDK)", desc: "Uses Claude Agent SDK to analyze code." },
];

type Ticket = {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assignee: string;
  labels: string[];
  created_at: string;
};

type Step = {
  step_id: string;
  node_name: string;
  attempt_number: number;
  decision: string;
  rationale: string;
  alternatives_considered: string[];
  confidence: number;
  exact_prompt: string;
  raw_llm_output: string;
  code_diff?: string | null;
  files_read: string[];
  tokens_used: number;
  timestamp: string;
  prev_attempt_id?: string | null;
  rejection_tag?: string | null;
  rejection_reason?: string | null;
};

type SessionState = {
  session_id: string;
  status: string;
  current_node?: string;
  ticket: Ticket;
  context_snapshot?: { files?: { path: string; content: string }[]; loaded_at?: string };
  latest_reasoning_step?: Step;
  current_plan?: string[];
  human_decisions: any[];
  reasoning_steps: Step[];
  execution_results: any[];
  validation_results?: any[];
  changed_files?: string[];
  rollback_metadata?: any[];
  retry_metadata?: any;
  git_status?: any;
};

function App() {
  const [view, setView] = useState<"dashboard" | "session" | "audit">("dashboard");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [state, setState] = useState<SessionState | null>(null);
  const [audit, setAudit] = useState<any>(null);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraConnected, setJiraConnected] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>("copilot");

  // useEffect(() => {
  //   fetch(`${API}/api/tickets`)
  //     .then((r) => r.json())
  //     .then(setTickets)
  //     .catch(console.error);

  //   refreshJiraStatus();
  // }, []);

  
  // useEffect(() => {
  //   async function initialize() {
  //     await refreshJiraStatus();
  //     await loadTickets();
  //   }

  //   initialize();
  // }, []);

  useEffect(() => {
    async function initialize() {
      const connected = await refreshJiraStatus();

      if (connected) {
        await loadTickets();
      }
    }

    initialize();
  }, []);

  useEffect(() => {
    if (!sessionId || view !== "session") return;
    let active = true;
    const load = () => fetch(`${API}/api/session/${sessionId}/state`)
      .then((r) => r.json())
      .then((data) => { if (active) setState(data); })
      .catch(console.error);
    load(); // immediate first load
    const timer = setInterval(load, 2000); // always poll, backend state gates it
    return () => { active = false; clearInterval(timer); };
  }, [sessionId, view]); // remove state?.status from deps

  useEffect(() => {
    if (view !== "audit" || !sessionId) return;
    fetch(`${API}/api/session/${sessionId}/audit`).then((r) => r.json()).then(setAudit).catch(console.error);
  }, [view, sessionId]);

  async function start(ticketId: string, provider: LLMProvider) {
    const res = await fetch(`${API}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id: ticketId, workspace_path: window.__JIRA_COPILOT_WORKSPACE_PATH__ || "", llm_provider: provider })
    });
    const data = await res.json();
    setSelectedTicket(null);
    setSessionId(data.session_id);
    setView("session");
  }


  async function connectJira() {
    setJiraLoading(true);
    try {
      const res = await fetch(`${API}/api/jira/connect`);
      const data = await res.json();
      if (data.auth_url) {
        vscode.postMessage({
          type: "openExternal",
          url: data.auth_url
        });
        // setTimeout(() => {
        //   refreshJiraStatus();
        // }, 3000);
        // setTimeout(async () => {
        //   await refreshJiraStatus();
        //   await loadTickets();
        // }, 3000);
        const interval = setInterval(async () => {
          try {
            const response = await fetch(`${API}/api/jira/status`);
            const data = await response.json();

            if (data.connected) {
              clearInterval(interval);

              setJiraConnected(true);

              await loadTickets();
            }
          } catch (err) {
            console.error(err);
          }
        }, 2000);
      }
    } finally {
      setJiraLoading(false);
    }
  }

  // async function refreshJiraStatus() {
  //   try {
  //     const response = await fetch(`${API}/api/jira/status`);
  //     const data = await response.json();

  //     setJiraConnected(Boolean(data.connected));
  //   } catch (err) {
  //     console.error("Failed to refresh Jira status", err);
  //   }
  // }

  async function refreshJiraStatus() {
    try {
      const response = await fetch(`${API}/api/jira/status`);
      const data = await response.json();

      const connected = Boolean(data.connected);

      setJiraConnected(connected);

      return connected;

    } catch (err) {
      console.error("Failed to refresh Jira status", err);
      return false;
    }
  }

  async function loadTickets() {
    try {
      const response = await fetch(`${API}/api/tickets`);

      if (response.status === 401) {
        setJiraConnected(false);
        return;
      }

      const data = await response.json();
      setTickets(data);

    } catch (err) {
      console.error(err);
    }
  }

  async function decide(decision: string, tag?: string, reason?: string) {
    if (!sessionId) return;
    const res = await fetch(`${API}/api/session/${sessionId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, tag, reason })
    });
    setState(await res.json());
  }

  if (selectedTicket) {
    return (
      <ProviderSelector
        ticket={selectedTicket}
        selectedProvider={selectedProvider}
        onSelectProvider={setSelectedProvider}
        onStart={() => start(selectedTicket.id, selectedProvider)}
        onBack={() => setSelectedTicket(null)}
      />
    );
  }

  if (view === "audit" && audit) {
    return <AuditReplay audit={audit} onBack={() => { setView("dashboard"); setAudit(null); }} />;
  }
  if (view === "session") {
    if (!state) return <main className="app"><p>Loading session...</p></main>;
    return <SessionView state={state} onDecision={decide} onAudit={() => setView("audit")} />;
  }
  return <Dashboard tickets={tickets} onStart={(id) => {
    const ticket = tickets.find(t => t.id === id);
    if (ticket) setSelectedTicket(ticket);
  }} onConnectJira={connectJira} jiraLoading={jiraLoading} jiraConnected={jiraConnected} />;
}

function Dashboard({ tickets, onStart, onConnectJira, jiraLoading, jiraConnected }: { tickets: Ticket[]; onStart: (id: string) => void; onConnectJira: () => void; jiraLoading: boolean; jiraConnected: boolean }) {
  return <main className="app">
    <header className="topbar">
      <div>
        <h1>JiraCopilot</h1>
        <span>{jiraConnected ? "Connected to Jira" : "Not connected to Jira"}</span>
      </div>
      <button onClick={onConnectJira} disabled={jiraLoading}>{jiraLoading ? "Connecting..." : "Connect Jira"}</button>
    </header>
    <section className="ticketList">
      {tickets.map((ticket) => <article className="ticketCard" key={ticket.id}>
        <div className="row gap"><span className="idBadge">{ticket.id}</span><Chip text={ticket.priority} kind="priority" /><Chip text={ticket.status} /></div>
        <h2>{ticket.title}</h2>
        <p className="clamp">{ticket.description}</p>
        <button onClick={() => onStart(ticket.id)}>Start</button>
      </article>)}
    </section>
  </main>;
}

function ProviderSelector({ ticket, selectedProvider, onSelectProvider, onStart, onBack }: {
  ticket: Ticket;
  selectedProvider: LLMProvider;
  onSelectProvider: (p: LLMProvider) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  return <main className="app">
    <header className="topbar">
      <div>
        <h1>JiraCopilot</h1>
      </div>
      <button className="ghost" onClick={onBack}>Back to tickets</button>
    </header>
    <article className="ticketDetail">
      <div className="row gap"><span className="idBadge">{ticket.id}</span><Chip text={ticket.priority} kind="priority" /><Chip text={ticket.status} /></div>
      <h2>{ticket.title}</h2>
      <p>{ticket.description}</p>
      <div className="labels">{ticket.labels.map((label) => <span key={label}>{label}</span>)}</div>
    </article>
    <section className="providerSelection">
      <h2>Choose LLM Provider</h2>
      <p className="subtitle">Select which AI to use for this task</p>
      <div className="providerCards">
        {LLM_PROVIDERS.map((p) => (
          <button
            key={p.value}
            className={`providerCard ${selectedProvider === p.value ? "selected" : ""}`}
            onClick={() => onSelectProvider(p.value)}
          >
            <div className="providerRadio">
              <div className={`radio ${selectedProvider === p.value ? "checked" : ""}`} />
            </div>
            <div className="providerInfo">
              <strong>{p.label}</strong>
              <span className="providerDesc">{p.desc}</span>
            </div>
          </button>
        ))}
      </div>
      <button className="startBtn" onClick={onStart}>
        Start with {LLM_PROVIDERS.find(p => p.value === selectedProvider)?.label}
      </button>
    </section>
  </main>;
}

function SessionView({ state, onDecision, onAudit }: { state: SessionState; onDecision: Function; onAudit: () => void }) {
  const pending = state.status.startsWith("PENDING_REVIEW");
  return <main className="sessionGrid">
    <aside className="panel">
      <h2>{state.ticket.id}</h2>
      <h3>{state.ticket.title}</h3>
      <p>{state.ticket.description}</p>
      <div className="row gap"><Chip text={state.ticket.priority} kind="priority" /><Chip text={state.ticket.status} /></div>
      <div className="labels">{state.ticket.labels.map((label) => <span key={label}>{label}</span>)}</div>
      <h3>Files in context</h3>
      <ul>{state.context_snapshot?.files?.map((file) => <li key={file.path}>{file.path}</li>)}</ul>
      <Chip text={state.status} pulse={!pending && state.status !== "COMMITTED"} />
    </aside>
    <section className="feed">
      <Timeline steps={state.reasoning_steps} />
      {state.status === "PENDING_REVIEW_REASONING" || state.status === "PENDING_REVIEW_PLAN"
        ? <ReviewStep step={state.latest_reasoning_step!} steps={state.reasoning_steps} onDecision={onDecision} />
        : null}
      {state.status === "PENDING_REVIEW_OUTPUT"
        ? <OutputReview results={state.execution_results} onDecision={onDecision} />
        : null}
      {state.status === "COMMITTED" ? <div className="success">Task completed and committed<button onClick={onAudit}>View Full Audit Trail</button></div> : null}
    </section>
    <aside className="panel">
      <h2>Live Audit</h2>
      {state.reasoning_steps.map((step) => <AuditMini key={step.step_id} step={step} />)}
    </aside>
  </main>;
}

function ReviewStep({ step, steps, onDecision }: { step: Step; steps: Step[]; onDecision: Function }) {
  const [rejecting, setRejecting] = useState(false);
  const [tag, setTag] = useState(tags[0]);
  const [reason, setReason] = useState("");
  const previous = step.prev_attempt_id ? steps.find((item) => item.step_id === step.prev_attempt_id) : null;
  return <article className="review">
    <div className="row between"><h2>{step.node_name} decision</h2>{step.attempt_number > 1 && <span className="retry">Retry #{step.attempt_number}</span>}</div>
    <Section title="Decision">{step.decision}</Section>
    <Section title="Rationale">{step.rationale}</Section>
    <h3>Alternatives considered</h3>
    <ul>{step.alternatives_considered.map((item) => <li key={item}>{item}</li>)}</ul>
    <Confidence value={step.confidence} />
    {previous ? <DiffBox diff={`--- previous decision\n+++ current decision\n-${previous.decision}\n+${step.decision}`} /> : null}
    <DecisionButtons rejecting={rejecting} setRejecting={setRejecting} tag={tag} setTag={setTag} reason={reason} setReason={setReason} onDecision={onDecision} />
  </article>;
}

function OutputReview({ results, onDecision }: { results: any[]; onDecision: Function }) {
  const [rejecting, setRejecting] = useState(false);
  const [tag, setTag] = useState(tags[0]);
  const [reason, setReason] = useState("");
  return <article className="review">
    <h2>Output review</h2>
    {results.map((result, index) => <div key={`${result.file}-${index}`}>
      <h3>{result.file}</h3>
      <p>{result.step}</p>
      {result.files?.length ? <p>Changed files: {result.files.join(", ")}</p> : null}
      {result.validation ? <ValidationSummary validation={result.validation} rollback={result.rollback} /> : null}
      <DiffBox diff={result.diff || "No working-tree diff captured"} />
    </div>)}
    <DecisionButtons rejecting={rejecting} setRejecting={setRejecting} tag={tag} setTag={setTag} reason={reason} setReason={setReason} onDecision={onDecision} />
  </article>;
}

function ValidationSummary({ validation, rollback }: { validation: any; rollback?: any }) {
  return <section>
    <h3>Validation</h3>
    <Chip text={validation.ok ? "passed" : "failed"} kind={validation.ok ? undefined : "priority"} />
    {validation.skipped ? <p>{validation.reason}</p> : null}
    {validation.commands?.map((cmd: any, index: number) => <pre key={index}>{cmd.command}
exit {cmd.exit_code}
{cmd.stdout}
{cmd.stderr}</pre>)}
    {rollback?.rolled_back ? <p>Rolled back: {rollback.reason}</p> : null}
  </section>;
}

function DecisionButtons(props: any) {
  return <div className="decisionBox">
    <div className="row gap">
      <button className="approve" onClick={() => props.onDecision("approved")}>APPROVE</button>
      <button className="reject" onClick={() => props.setRejecting(!props.rejecting)}>REJECT</button>
    </div>
    {props.rejecting ? <div className="rejectForm">
      <select value={props.tag} onChange={(e) => props.setTag(e.target.value)}>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select>
      <textarea value={props.reason} onChange={(e) => props.setReason(e.target.value)} placeholder="Reason for rejection" />
      <button className="reject" onClick={() => props.onDecision("rejected", props.tag, props.reason)}>Submit Rejection</button>
    </div> : null}
  </div>;
}

function AuditReplay({ audit, onBack }: { audit: any; onBack: () => void }) {
  const [node, setNode] = useState("All");
  const [decision, setDecision] = useState("All");
  const [attempt, setAttempt] = useState("All");
  const events = useMemo(() => audit.timeline.filter((event: any) => {
    if (node !== "All" && event.node_name !== node) return false;
    if (decision !== "All" && event.decision !== decision) return false;
    if (attempt === "First attempts only" && event.attempt_number && event.attempt_number !== 1) return false;
    if (attempt === "Retries only" && event.attempt_number && event.attempt_number === 1) return false;
    return true;
  }), [audit, node, decision, attempt]);
  return <main className="app">
    <header className="topbar">
      <div><h1>{audit.ticket.id} Audit Replay</h1><span>{audit.started_at} - {audit.committed_at || "open"} - attempts {audit.total_attempts}</span></div>
    </header>
    <div className="filters">
      <select value={node} onChange={(e) => setNode(e.target.value)}>{["All", "reason", "plan", "execute"].map((x) => <option key={x}>{x}</option>)}</select>
      <select value={decision} onChange={(e) => setDecision(e.target.value)}>{["All", "approved", "rejected"].map((x) => <option key={x}>{x}</option>)}</select>
      <select value={attempt} onChange={(e) => setAttempt(e.target.value)}>{["All", "First attempts only", "Retries only"].map((x) => <option key={x}>{x}</option>)}</select>
    </div>
    {events.map((event: any, index: number) => <EventCard key={`${event.type}-${index}`} event={event} steps={audit.reasoning_steps} />)}
    <button onClick={onBack}>Back to Dashboard</button>
  </main>;
}

function EventCard({ event, steps }: { event: any; steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const prev = event.prev_attempt_id ? steps.find((step) => step.step_id === event.prev_attempt_id) : null;
  return <article className="event">
    <button className="plain" onClick={() => setOpen(!open)}>{event.type} {event.node_name || event.gate || event.file} <span>{event.timestamp}</span></button>
    {open && event.type === "reasoning_step" ? <div>
      <Section title="Decision">{event.decision}</Section>
      <Section title="Rationale">{event.rationale}</Section>
      <ul>{event.alternatives_considered?.map((x: string) => <li key={x}>{x}</li>)}</ul>
      <Confidence value={event.confidence} />
      <pre>{event.exact_prompt}</pre>
      <pre>{event.raw_llm_output}</pre>
      <p>Files: {event.files_read?.join(", ") || "retry prompt only"}</p>
      <p>Tokens used: {event.tokens_used}</p>
      {prev ? <DiffBox diff={wordDiff(prev.decision, event.decision, "decision")} /> : null}
    </div> : null}
    {open && event.type === "human_decision" ? <div><Chip text={event.decision} /><p>{event.tag} {event.reason}</p></div> : null}
    {open && event.type === "execution_result" ? <div><p>{event.step}</p><h3>{event.file}</h3><DiffBox diff={event.diff} /></div> : null}
  </article>;
}

function Timeline({ steps }: { steps: Step[] }) {
  return <div className="timeline">{steps.map((step) => <article key={step.step_id} className="event compact">
    <div className="row between"><Chip text={step.node_name} /><span>Attempt {step.attempt_number}</span></div>
    <time>{step.timestamp}</time>
  </article>)}</div>;
}

function AuditMini({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return <article className="mini" onClick={() => setOpen(!open)}>
    <div className="row between"><Chip text={step.node_name} /><span>#{step.attempt_number}</span></div>
    <p className="oneLine">{step.decision}</p>
    <Confidence value={step.confidence} small />
    {open ? <div><p>{step.rationale}</p><pre>{step.exact_prompt}</pre></div> : null}
  </article>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3><p>{children}</p></section>;
}

function Chip({ text, kind, pulse }: { text: string; kind?: string; pulse?: boolean }) {
  return <span className={`chip ${kind || ""} p-${text.toLowerCase()} ${pulse ? "pulse" : ""}`}>{text}</span>;
}

function Confidence({ value, small }: { value: number; small?: boolean }) {
  const cls = value > 0.8 ? "good" : value > 0.6 ? "warn" : "bad";
  return <div className={`confidence ${small ? "small" : ""}`}><span className={cls} style={{ width: `${value * 100}%` }} /></div>;
}

function DiffBox({ diff }: { diff: string }) {
  return <pre className="diff">{diff.split("\n").map((line, i) => <span key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>{line + "\n"}</span>)}</pre>;
}

function wordDiff(before: string, after: string, label: string) {
  return `--- previous ${label}\n+++ current ${label}\n-${before}\n+${after}`;
}

const style = document.createElement("style");
style.textContent = `
body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
button, select, textarea { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 8px 10px; font: inherit; }
select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-badge-background); width: 100%; box-sizing: border-box; }
textarea { min-height: 72px; resize: vertical; }
h1, h2, h3, p { margin-top: 0; }
.app { padding: 14px; }
.topbar { display: flex; justify-content: space-between; margin-bottom: 14px; }
.topbar h1 { font-size: 22px; margin-bottom: 2px; }
.ticketList { display: grid; gap: 10px; }
.ticketCard, .panel, .review, .event, .mini { border: 1px solid var(--vscode-badge-background); border-radius: 6px; padding: 12px; background: var(--vscode-editor-background); }
.ticketCard:hover, .mini:hover { background: var(--vscode-list-hoverBackground); }
.row { display: flex; align-items: center; }
.between { justify-content: space-between; }
.gap { gap: 8px; flex-wrap: wrap; }
.idBadge { color: var(--vscode-textLink-foreground); font-weight: 700; }
.chip { display: inline-flex; padding: 3px 7px; border-radius: 999px; background: var(--vscode-badge-background); font-size: 11px; align-items: center; }
.p-critical, .reject, .bad { background: var(--vscode-testing-iconFailed); color: var(--vscode-button-foreground); }
.p-high { background: var(--vscode-charts-orange); color: var(--vscode-editor-background); }
.p-medium, .warn { background: var(--vscode-charts-yellow); color: var(--vscode-editor-background); }
.p-low { background: var(--vscode-disabledForeground); color: var(--vscode-editor-background); }
.approve, .good, .success { background: var(--vscode-testing-iconPassed); color: var(--vscode-button-foreground); }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sessionGrid { display: grid; grid-template-columns: 25% 1fr 25%; gap: 10px; padding: 10px; min-width: 900px; }
.feed { display: grid; gap: 10px; align-content: start; }
.labels { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
.labels span { background: var(--vscode-badge-background); padding: 3px 6px; border-radius: 4px; }
.pulse { animation: pulse 1.4s infinite; }
@keyframes pulse { 50% { opacity: .45; } }
.timeline { display: grid; gap: 8px; }
.compact time { font-size: 11px; opacity: .8; }
.review { display: grid; gap: 10px; }
.retry { background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); border-radius: 4px; padding: 3px 6px; }
.confidence { height: 9px; background: var(--vscode-input-background); border-radius: 999px; overflow: hidden; }
.confidence.small { height: 5px; }
.confidence span { display: block; height: 100%; }
.decisionBox, .rejectForm { display: grid; gap: 8px; }
pre { white-space: pre-wrap; overflow: auto; max-height: 200px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 8px; border-radius: 4px; }
.diff .add { color: #2ea043; }
.diff .del { color: #f85149; }
.ghost { background: transparent; color: var(--vscode-textLink-foreground); padding: 0; }
.ghost:hover { text-decoration: underline; }
.ticketDetail { border: 1px solid var(--vscode-badge-background); border-radius: 6px; padding: 14px; margin-bottom: 14px; }
.ticketDetail h2 { margin: 8px 0; }
.providerSelection { display: grid; gap: 10px; }
.providerSelection .subtitle { color: var(--vscode-disabledForeground); font-size: 13px; margin-bottom: 8px; }
.providerCards { display: grid; gap: 8px; }
.providerCard { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 14px; text-align: left; background: var(--vscode-editor-background); border: 2px solid var(--vscode-badge-background); border-radius: 8px; cursor: pointer; transition: border-color .15s, background .15s; }
.providerCard:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-textLink-foreground); }
.providerCard.selected { border-color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 8%, var(--vscode-editor-background)); }
.providerRadio { padding-top: 2px; }
.radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--vscode-badge-background); display: flex; align-items: center; justify-content: center; transition: border-color .15s, background .15s; }
.radio.checked { border-color: var(--vscode-testing-iconPassed); background: var(--vscode-testing-iconPassed); }
.radio.checked::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-editor-background); }
.providerInfo { display: grid; gap: 3px; }
.providerInfo strong { font-size: 14px; }
.providerDesc { font-size: 12px; color: var(--vscode-disabledForeground); line-height: 1.4; }
.startBtn { margin-top: 6px; padding: 12px 16px; font-size: 14px; font-weight: 600; background: var(--vscode-testing-iconPassed); color: var(--vscode-button-foreground); border: 0; border-radius: 8px; cursor: pointer; transition: opacity .15s; }
.startBtn:hover { opacity: .85; }
.success { padding: 12px; border-radius: 6px; display: grid; gap: 10px; }
.mini { margin-bottom: 8px; cursor: pointer; }
.oneLine { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plain { width: 100%; display: flex; justify-content: space-between; background: transparent; color: var(--vscode-foreground); text-align: left; padding: 0; }
.filters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
@media (max-width: 980px) { .sessionGrid { grid-template-columns: 1fr; min-width: 0; } }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(<App />);
