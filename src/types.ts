export type Usage = { input: string; output: string };

export type StopReason = "stop" | "length" | "toolUsage" | "error";

export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ContentBlock = TextBlock | ToolCallBlock;

export type UserMessage = { role: "user"; content: string };

export type AssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
  usage: Usage;
  stop_reason: StopReason;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  result: string;
  isError: boolean;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ToolSpec = { name: string; description: string; parameters: any };

export type Tool = ToolSpec & {
  execute(args: Record<string, unknown>): Promise<string>;
};

export type StreamType =
  | { type: "text_delta"; delta: string }
  | { type: "done"; message: AssistantMessage };

export type StreamOptions = {
  messages: Message[];
  model: string;
  system?: string;
  tools?: Tool[];
};

export interface Provider {
  name: string;
  defaultModel: string;
  stream: (options: StreamOptions) => AsyncIterable<StreamType>;
}

/** All reasons the agentic loop can exit */
export type LoopExitReason =
  | "done"           // Model ne final answer diya
  | "max_turns"      // Safety limit hit ho gayi
  | "length"         // Model ka output token limit hit hua
  | "error";         // Unrecoverable error aaya
