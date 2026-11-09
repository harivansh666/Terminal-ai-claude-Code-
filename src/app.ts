import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { getProvider } from "./models/index.js";
import type { Message } from "./types.js";

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
const messages: Message[] = [{ role: "user", content: values.prompt }];

for await (const event of provider.stream({
  messages,
  model: selectedModel,
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  } else {
    const { content, role, usage, stop_reason } = event.message;
    console.log(
      `\n\nFinal Message:\n- content: ${content}\n- role: ${role}\n- usage: (input: ${usage.input}, output: ${usage.output})\n- stop_reason: ${stop_reason}`,
    );
  }
}
process.stdout.write("\n");
