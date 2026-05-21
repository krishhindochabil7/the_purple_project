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

      for await (const msg of stream){
        if ("content" in msg) {
          for (const b of (msg.content as unknown) as any[]) {
            if (b.type === "text") chunks.push(b.text);
          }
        }
      }
      return chunks.join("\n");
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