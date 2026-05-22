// import { query } from "@anthropic-ai/claude-agent-sdk";
 
export class CodeInsights {
  constructor(private repoPath: string) {}
 
  private async ask(prompt: string, system?: string): Promise<string> {
    try{
      console.log("PATH:", process.env.PATH);
      console.log("BEFORE IMPORT");

      const sdk = await import("@anthropic-ai/claude-agent-sdk");

      console.log("AFTER IMPORT");

      const { query } = sdk;

      console.log("AFTER QUERY EXTRACT");
      console.log("repoPath:", this.repoPath);

      if (!this.repoPath) {
        throw new Error("repoPath is undefined");
      }
      console.log("QUERY FUNCTION:", query);
      console.log("QUERY TYPE:", typeof query);
      console.log("SYSTEM:", system);
      console.log("PROMPT PREVIEW:", prompt.slice(0, 200));

      const stream = query({
        prompt,
        options: {
          cwd: this.repoPath,
          systemPrompt: system,
          permissionMode: "acceptEdits",
          allowedTools: ["Read", "Grep", "Glob", "Bash"],
        },
      });

      console.log("STREAM CREATED:", stream);

      const chunks: string[] = [];
      let finalResult = "";

      for await (const msg of stream as AsyncIterable<any>){
        console.log("CLAUDE MSG TYPE:", msg?.type);
        if (msg?.type === "assistant" && Array.isArray(msg?.message?.content)) {
          for (const b of msg.message.content) {
            if (b?.type === "text" && typeof b.text === "string") chunks.push(b.text);
          }
        } else if (msg?.type === "result" && typeof msg?.result === "string") {
          finalResult = msg.result;
        }
      }
      return chunks.join("\n") || finalResult;
    } catch (e) {
    console.error("CLAUDE FAILURE");
    console.error(e);

    if (e instanceof Error) {
      console.error("MESSAGE:", e.message);
      console.error("STACK:", e.stack);
    }

    throw e;
  }
} 
  qa(q: string)          { return this.ask(q, "Code intelligence assistant. Cite files/lines. Ignore virtual environment directories (.venv*, venv/, __pycache__/) and .env files."); }
  review(input: string)  { return this.ask(`Review:\n\n${input}`, "Senior reviewer. Be concrete. Ignore virtual environment directories (.venv*, venv/, __pycache__/) and .env files."); }
  metrics(target = ".")  { return this.ask(`Analyze ${target}: complexity, dead code, deps. Do not analyze virtual environment directories (.venv*, venv/, __pycache__/) or .env files.`); }
}