import { GoogleGenAI } from "@google/genai";
import type {
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamOptions,
  StreamType,
  TextBlock,
  ToolCallBlock,
  ToolResultMessage,
} from "../types.js";

const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Converts standard chat messages into the Gemini Interactions API input format.
 * UserMessage      → user_input step
 * AssistantMessage → model_output step (only text parts)
 * ToolResultMessage → function_result step
 */
function formatInputMessages(messages: Message[]) {
  return messages.map((message) => {
    if (message.role === "user") {
      return {
        type: "user_input" as const,
        content: [{ type: "text" as const, text: message.content }],
      };
    } else if (message.role === "toolResult") {
      // Tool execution ka result Gemini ko wapas bhejo
      return {
        type: "function_result" as const,
        call_id: message.toolCallId,
        name: message.toolName,
        result: message.result,
        ...(message.isError ? { is_error: true } : {}),
      };
    } else {
      // AssistantMessage — sirf text parts pass karo
      const textParts = message.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => ({ type: "text" as const, text: block.text }));

      return {
        type: "model_output" as const,
        content: textParts,
      };
    }
  });
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

      // Tools ko Gemini ke format me convert karo
      const geminiTools = options.tools?.length
        ? options.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))
        : undefined;

      // Start the Gemini interaction stream
      const stream = await ai.interactions.create({
        model,
        input: formatInputMessages(options.messages),
        ...(options.system ? { system_instruction: options.system } : {}),
        ...(geminiTools ? { tools: geminiTools } : {}),
        generation_config: {
          temperature: 0.9,
          max_output_tokens: 8192,
        },
        stream: true,
      });

      let textContent = "";
      // stepIndex → { id, name, argStr } — arguments_delta events se collect karo
      const pendingCalls = new Map<number, { id: string; name: string; argStr: string }>();
      const toolCalls: ToolCallBlock[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: StopReason = "stop";

      for await (const event of stream) {
        // 1. Text chunks stream karo
        if (event.event_type === "step.delta" && event.delta.type === "text") {
          textContent += event.delta.text;
          yield { type: "text_delta", delta: event.delta.text };
        }

        // 2. Function call step shuru — id aur naam note karo
        if (event.event_type === "step.start" && event.step.type === "function_call") {
          pendingCalls.set(event.index, {
            id: event.step.id,
            name: event.step.name,
            argStr: "",
          });
        }

        // 3. Arguments chunks collect karo (string deltas)
        if (
          event.event_type === "step.delta" &&
          event.delta.type === "arguments_delta" &&
          event.delta.arguments
        ) {
          const pending = pendingCalls.get(event.index);
          if (pending) {
            pending.argStr += event.delta.arguments;
          }
        }

        // 4. Function call step khatam — arguments parse karke toolCall banao
        if (event.event_type === "step.stop") {
          const pending = pendingCalls.get(event.index);
          if (pending) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = pending.argStr ? JSON.parse(pending.argStr) : {};
            } catch {
              // JSON parse fail — empty args rakhein
            }
            toolCalls.push({
              type: "toolCall",
              id: pending.id,
              name: pending.name,
              arguments: parsedArgs,
            });
            pendingCalls.delete(event.index);
          }
        }

        // 5. Token usage track karo
        if (event.event_type === "step.delta" && event.metadata?.total_usage) {
          inputTokens =
            event.metadata.total_usage.total_input_tokens ?? inputTokens;
          outputTokens =
            event.metadata.total_usage.total_output_tokens ?? outputTokens;
        }

        // 6. Interaction complete hone par finalize karo
        if (event.event_type === "interaction.completed") {
          const { status, usage } = event.interaction;
          stopReason = mapStatusToStopReason(status);
          inputTokens = usage?.total_input_tokens ?? inputTokens;
          outputTokens = usage?.total_output_tokens ?? outputTokens;
        }
      }

      // Content blocks prepare karo (text + tool calls)
      const content: ContentBlock[] = [];
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }
      content.push(...toolCalls);

      // Final message emit karo
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
