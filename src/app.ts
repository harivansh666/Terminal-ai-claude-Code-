import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { getProvider } from "./models/index.js";

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
const model = values.model ?? provider.defaultModel;

for await (const event of provider.stream({
  messages: [{ role: "user", content: values.prompt }],
  model,
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  }
}
