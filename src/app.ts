import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { runAgentLoop } from "./agent/loop.js";
import { getProvider } from "./models/index.js";
import { readTool } from "./tools/read-tool.js";

dotenv.config();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    prompt:   { type: "string",  short: "p" },
    provider: { type: "string",  default: "gemini" },
    model:    { type: "string",  short: "m", default: "gemini-3.8-flash" },
  },
});

if (!values.prompt) {
  console.error("Usage: pnpm dev -p \"your prompt\" [-m model] [--provider gemini]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const provider = getProvider(values.provider!);

const exitReason = await runAgentLoop({
  provider,
  model:    values.model ?? provider.defaultModel,
  messages: [{ role: "user", content: values.prompt }],
  tools:    [readTool],

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
