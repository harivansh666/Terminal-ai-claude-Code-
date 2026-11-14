import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { runAgentLoop } from "./agent/loop.js";
import { PolicyGuard } from "./agent/policy.js";
import { getProvider } from "./models/index.js";
import { readTool } from "./tools/read-tool.js";
import { bashTool } from "./tools/bash.js";

dotenv.config();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    provider: { type: "string", default: "gemini" },
    model: { type: "string", short: "m", default: "gemini-3.8-flash" },
  },
});

if (!values.prompt) {
  console.error("Usage: pnpm dev -p \"your prompt\" [-m model] [--provider gemini]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Security Policy Setup
// ---------------------------------------------------------------------------

// Protected files & directories jinko model kabhi delete ya modify nahi kar sakta
const policy = new PolicyGuard({
  workspaceRoot: process.cwd(),
  alwaysDenyPaths: [
    "src/app.ts",
    "src/agent",
    "src/types.ts",
    ".env",
    ".git",
    "node_modules",
  ],
  alwaysAllowRead: true, // Safe commands jaise ls, cat, git status auto-allow
  nonInteractive: false, // Terminal par user se y/N confirmation lega for dangerous/write operations
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const provider = getProvider(values.provider!);

const exitReason = await runAgentLoop({
  provider,
  model: values.model ?? provider.defaultModel,
  messages: [{ role: "user", content: values.prompt }],
  tools: [readTool, bashTool],
  policy, // <-- Security policy guard attached

  // Text stream as it arrives
  onText: (delta) => process.stdout.write(delta),

  // End of each turn — optional logging
  onTurnEnd: (msg, turn) => {
    if (msg.stop_reason !== "stop") {
      process.stderr.write(`\n[Turn ${turn}] stop_reason=${msg.stop_reason}\n`);
    }
  },
});

process.stdout.write("\n");

// Non-zero exit on failure so CI/scripts detect it
if (exitReason === "error" || exitReason === "max_turns") {
  process.exit(1);
}
