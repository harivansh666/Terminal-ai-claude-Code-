import { GoogleGenAI } from "@google/genai";
import type {
  Message,
  Provider,
  StopReason,
  StreamOptions,
  StreamType,
} from "../types.js";

const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Converts standard chat messages into the Gemini Interactions API input format.
 */
function formatInputMessages(messages: Message[]) {
  return messages.map((message) => ({
    type:
      message.role === "user"
        ? ("user_input" as const)
        : ("model_output" as const),
    content: [{ type: "text" as const, text: message.content }],
  }));
}

/**
 * Maps the Gemini interaction status to our unified StopReason type.
 */
function mapStatusToStopReason(status: string): StopReason {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
    case "budget_exceeded":
      return "length";
    case "requires_action":
      return "toolUsage";
    case "failed":
    case "cancelled":
      throw new Error(`Gemini interaction ${status}`);
    default:
      throw new Error(`Unexpected Gemini interaction status: ${status}`);
  }
}

/**
 * Creates and configures the Gemini model provider.
 */
export function createProvider(): Provider {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Please set the GEMINI_API_KEY environment variable");
  }

  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",
    defaultModel: DEFAULT_MODEL,

    stream: async function* (
      options: StreamOptions,
    ): AsyncGenerator<StreamType, void, unknown> {
      const model = options.model || DEFAULT_MODEL;

      // Start the Gemini interaction stream
      const stream = await ai.interactions.create({
        model,
        input: formatInputMessages(options.messages),
        ...(options.system ? { system_instruction: options.system } : {}),
        generation_config: {
          temperature: 0.9,
          max_output_tokens: 1024,
        },
        stream: true,
      });

      let content = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: StopReason = "stop";

      for await (const event of stream) {
        // 1. Emit text delta events as response chunks arrive
        if (event.event_type === "step.delta" && event.delta.type === "text") {
          content += event.delta.text;
          yield { type: "text_delta", delta: event.delta.text };
        }

        // 2. Capture token usage reported in stream deltas
        if (event.event_type === "step.delta" && event.metadata?.total_usage) {
          inputTokens =
            event.metadata.total_usage.total_input_tokens ?? inputTokens;
          outputTokens =
            event.metadata.total_usage.total_output_tokens ?? outputTokens;
        }

        // 3. Finalize completion status and token totals
        if (event.event_type === "interaction.completed") {
          const { status, usage } = event.interaction;
          stopReason = mapStatusToStopReason(status);

          inputTokens = usage?.total_input_tokens ?? inputTokens;
          outputTokens = usage?.total_output_tokens ?? outputTokens;
        }
      }

      // 4. Emit the final message with complete content and token usage
      yield {
        type: "done",
        message: {
          role: "assistant",
          content,
          usage: {
            input: String(inputTokens),
            output: String(outputTokens),
          },
          stop_reason: stopReason,
        },
      };
    },
  };
}
