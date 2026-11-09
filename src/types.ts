export type Usage = { input: string; output: string };

export type StopReason = "stop" | "length" | "toolUsage";
export type TextBlock = { type: "text"; text: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type contentBlock = TextBlock | ToolCallBlock;

export type UserMessage = { role: "user"; content: string };
export type AssistantMessage = {
  role: "assistant";
  content: contentBlock[];
  usage: Usage;
  stop_reason: StopReason;
};

export type toolCallResult = {
  role: "roolResult";
  toolCallId: string;
  result: string;
  isError: boolean;
};
export type Message = UserMessage | AssistantMessage;

export type ToolSpec = { name: string; description: string };
export type Tool = ToolSpec & {
  execute(args: Record<string, unknown>): Promise<string>;
};

// Tool ik ese ts type aa jis vich toolspec de sari property hovegi, plus execute() method (function) ve hovega

export type StreamType =
  | {
      type: "text_delta";
      delta: string;
    }
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
