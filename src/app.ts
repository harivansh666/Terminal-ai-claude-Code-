import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
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
});
console.log(interaction.output_text);

console.log(values);
