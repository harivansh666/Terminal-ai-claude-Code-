import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { createProvider } from "./models/gemini.js";

dotenv.config();

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    model: { type: "string", short: "m", default: "gemini-3.8-flash" },
  },
});

if (!values.prompt) {
  console.error("Please provide a prompt");
  process.exit(1);
}

const provider = createProvider();
const model = values.model ?? provider.defaultModel;

for await (const event of provider.stream({
  messages: [{ role: "user", content: values.prompt }],
  model,
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
}
