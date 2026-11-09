export type Usage = { input: string; output: string };

export type StopReason = "stop" | "length" | "toolUsage";

export type UserMessage = { role: "user"; content: string };
export type AssistantMessage = {
  role: "assistant";
  content: string;
  usage: Usage;
  stop_reason: StopReason;
};

export type Message = UserMessage | AssistantMessage;

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
};

export interface Provider {
  name: string;
  defaultModel: string;
  stream: (options: StreamOptions) => AsyncIterable<StreamType>;
}
