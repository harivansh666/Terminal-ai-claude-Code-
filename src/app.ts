import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { getProvider } from "./models/index.js";
import { readTool } from "./tools/read-tool.js";
import type {
  LoopExitReason,
  Message,
  Tool,
  ToolCallBlock,
  ToolResultMessage,
} from "./types.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Maximum agentic turns before we force-stop (infinite loop guard) */
const MAX_TURNS = 10;

/** Tool execution timeout in milliseconds */
const TOOL_TIMEOUT_MS = 30_000;

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
// Setup
// ---------------------------------------------------------------------------

const provider = getProvider(values.provider!);
const selectedModel = values.model ?? provider.defaultModel;

const tools: Tool[] = [readTool];
const toolMap = new Map(tools.map((t) => [t.name, t]));

const messages: Message[] = [{ role: "user", content: values.prompt }];

// ---------------------------------------------------------------------------
// Tool execution helper (with timeout)
// ---------------------------------------------------------------------------

async function executeTool(
  call: ToolCallBlock,
): Promise<ToolResultMessage> {
  const tool = toolMap.get(call.name);

  if (!tool) {
    console.error(`\n[ERROR] Unknown tool: "${call.name}"`);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      result: `Tool "${call.name}" is not available.`,
      isError: true,
    };
  }

  console.error(`\n[Tool] ${call.name}(${JSON.stringify(call.arguments)})`);

  // Timeout wrapper — agar tool zyada der le to fail karo
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Tool "${call.name}" timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS),
  );

  try {
    const result = await Promise.race([tool.execute(call.arguments), timeoutPromise]);
    console.error(`[Tool] ${call.name} → OK (${result.length} chars)`);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Tool] ${call.name} → ERROR: ${message}`);
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      result: `Error: ${message}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

async function runAgentLoop(): Promise<LoopExitReason> {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // ── 1. Model se stream lo ──────────────────────────────────────────────
    let assistantMessage = null as (typeof messages)[number] | null;

    try {
      for await (const event of provider.stream({ messages, model: selectedModel, tools })) {
        if (event.type === "text_delta") {
          process.stdout.write(event.delta);
        } else {
          // event.type === "done"
          assistantMessage = event.message;
        }
      }
    } catch (err) {
      // Network error, API error, failed/cancelled status, etc.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n[ERROR] Stream failed: ${message}`);
      return "error";
    }

    if (!assistantMessage || assistantMessage.role !== "assistant") {
      console.error("\n[ERROR] No response received from model");
      return "error";
    }

    // Response history me save karo
    messages.push(assistantMessage);

    const { stop_reason } = assistantMessage;

    // ── 2. Stop reason ke hisab se decide karo ────────────────────────────

    // Model ne final answer diya — kaam khatam
    if (stop_reason === "stop") {
      process.stdout.write("\n");
      return "done";
    }

    // Token limit hit ho gayi — jo mila woh print ho chuka, gracefully exit
    if (stop_reason === "length") {
      process.stdout.write("\n");
      console.error("\n[WARN] Response cut off — model reached output token limit.");
      return "length";
    }

    // ── 3. Tool call handle karo ──────────────────────────────────────────
    if (stop_reason === "toolUsage") {
      const toolCalls = assistantMessage.content.filter(
        (b): b is ToolCallBlock => b.type === "toolCall",
      );

      if (toolCalls.length === 0) {
        // Model ne toolUsage bola lekin call nahi — unexpected, exit karo
        console.error("\n[ERROR] stop_reason=toolUsage but no tool calls in response");
        return "error";
      }

      // Saare tool calls parallel execute karo
      const results = await Promise.all(toolCalls.map(executeTool));

      // Results history me daalo
      for (const result of results) {
        messages.push(result);
      }

      // Loop continue — model ko results ke saath call karo
      continue;
    }

    // Koi aur unexpected stop reason
    console.error(`\n[ERROR] Unexpected stop_reason: "${stop_reason}"`);
    return "error";
  }

  // MAX_TURNS hit — infinite loop guard
  console.error(`\n[ERROR] Agent stopped: exceeded maximum turns (${MAX_TURNS})`);
  return "max_turns";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const exitReason = await runAgentLoop();

// Non-zero exit code on failure
if (exitReason === "error" || exitReason === "max_turns") {
  process.exit(1);
}
