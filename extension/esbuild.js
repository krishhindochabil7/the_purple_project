const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info"
};

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode", "@anthropic-ai/claude-agent-sdk"]
  },
  {
    ...common,
    entryPoints: ["src/webview/App.tsx"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    loader: { ".tsx": "tsx" }
  }
];

async function run() {
  if (watch) {
    const contexts = await Promise.all(builds.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching JiraCopilot extension...");
    return;
  }
  await Promise.all(builds.map((config) => esbuild.build(config)));
}

run().catch(() => process.exit(1));
