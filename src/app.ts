import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { getProvider } from "./models/index.js";
import { readTool } from "./tools/read-tool.js";
import type { Message, Tool, ToolCallBlock, ToolResultMessage } from "./types.js";

dotenv.config();

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    provider: { type: "string", default: "gemini" },
    model: { type: "string", short: "m", default: "gemini-3.8-flash" },
  },
});

if (!values.prompt) {
  console.error("Please provide a prompt -p prompt -m model");
  process.exit(1);
}

const provider = getProvider(values.provider);
const selectedModel = values.model ?? provider.defaultModel;

// Available tools ka map — naam se tool dhundne ke liye
const tools: Tool[] = [readTool];
const toolMap = new Map(tools.map((t) => [t.name, t]));

// Conversation history
const messages: Message[] = [{ role: "user", content: values.prompt }];

// Agentic loop — tool calls ke baad dobara model se baat karo
while (true) {
  let assistantMessage: Message | null = null;

  for await (const event of provider.stream({ messages, model: selectedModel, tools })) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else {
      assistantMessage = event.message;
    }
  }

  if (!assistantMessage) break;

  // Assistant response history me daalo
  messages.push(assistantMessage);

  // Check karo koi tool call hai?
  const toolCalls = assistantMessage.role === "assistant"
    ? assistantMessage.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
    : [];

  // Agar koi tool call nahi to loop khatam
  if (toolCalls.length === 0) break;

  // Har tool call execute karo
  console.log(`\n\n[Tool calls: ${toolCalls.map((t) => t.name).join(", ")}]`);

  for (const call of toolCalls) {
    const tool = toolMap.get(call.name);
    let result: string;
    let isError = false;

    if (!tool) {
      result = `Error: Tool "${call.name}" not found`;
      isError = true;
    } else {
      try {
        console.log(`[Executing: ${call.name}(${JSON.stringify(call.arguments)})]`);
        result = await tool.execute(call.arguments);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }
    }

    // Tool result ko history me daalo
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError,
    };
    messages.push(toolResult);
  }

  // Loop continue — model ko tool results ke saath dobara call karo
}

process.stdout.write("\n");



// =================================================================================
// 1. Hum model ko tools ki LIST bhejte hain  →  (name + description + params)
//                                                        ↓
// 2. Model decide karta hai kaunsa tool use karna hai
//                                                        ↓
// 3. Model response me sirf yeh bhejta hai:
//    { type: "toolCall", name: "read", arguments: { path: "package.json" } }
//                                                        ↓
// 4. HAMARA app.ts yeh dekh ke:
//    tool.execute({ path: "package.json" })  →  actual file read karta hai
//                                                        ↓
// 5. Result model ko wapas bhejte hain
//                                                        ↓
// 6. Model ab file content padh ke final answer deta hai

// ===================================================================================

// while (true) {                              ← Loop shuru
// │
// │  ┌─────────────────────────────────────────────────────┐
// ├──│  📡 MODEL SE STREAM LO                              │
// │  │                                                     │
// │  │  for await (const event of provider.stream(...)) {  │  ← L36
// │  │    if (event.type === "text_delta") {               │  ← L37
// │  │      process.stdout.write(event.delta);             │  ← L38  (text print karo)
// │  │    } else {                                         │
// │  │      assistantMessage = event.message;              │  ← L40  (final msg save karo)
// │  │    }                                                │
// │  │  }                                                  │  ← L42
// │  └─────────────────────────────────────────────────────┘
// │
// │  ┌─────────────────────────────────────────────────────┐
// ├──│  ❌ KOI TOOL CALL NAHI? → break                     │
// │  │                                                     │
// │  │  if (toolCalls.length === 0) break;                 │  ← L55
// │  └─────────────────────────────────────────────────────┘
// │
// │  ┌─────────────────────────────────────────────────────┐
// ├──│  🔧 TOOL CALL HAI? → EXECUTE KARO                  │
// │  │                                                     │
// │  │  for (const call of toolCalls) {                   │  ← L60
// │  │    result = await tool.execute(call.arguments);     │  ← L71
// │  │    messages.push(toolResult);                       │  ← L86  (result history me)
// │  │  }                                                  │
// │  └─────────────────────────────────────────────────────┘
// │
// └──── Loop dobara (L33 pe wapas jaao, model ko result ke saath call karo)
// }