import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { parseArgs } from "node:util";

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

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

const interaction = await ai.interactions.create({
  model: "gemini-3.8-flash",
  input: values.prompt,
  generation_config: {
    temperature: 0.9,
    max_output_tokens: 255,
  },
  stream: true,
});

for await (const event of interaction) {
  if (event.event_type === "step.delta") {
    if (event.delta.type === "text") {
      process.stdout.write(event.delta.text);
    }
  }
}

console.log(values);
