import type {
    AssistantMessage,
    LoopExitReason,
    Message,
    Provider,
    Tool,
    ToolCallBlock,
    ToolResultMessage,
} from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Maximum agentic turns before we force-stop (infinite loop guard) */
const MAX_TURNS = 10;

/** Tool execution timeout in milliseconds */
const TOOL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentLoopOptions = {
    provider: Provider;
    model: string;
    messages: Message[];
    tools: Tool[];
    system?: string;
    /** Called with each text chunk as it streams */
    onText?: (delta: string) => void;
    /** Called at the end of each turn with the full assistant message */
    onTurnEnd?: (message: AssistantMessage, turn: number) => void;
};

// ---------------------------------------------------------------------------
// Internal: single tool call execute karo (with timeout)
// ---------------------------------------------------------------------------

async function executeTool(
    call: ToolCallBlock,
    toolMap: Map<string, Tool>,
): Promise<ToolResultMessage> {
    const tool = toolMap.get(call.name);

    // Unknown tool — model ne kuch aisa maanga jo register nahi
    if (!tool) {
        console.error(`[loop] Unknown tool requested: "${call.name}"`);
        return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            result: `Tool "${call.name}" is not available.`,
            isError: true,
        };
    }

    console.error(`[loop] Executing: ${call.name}(${JSON.stringify(call.arguments)})`);

    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
            () => reject(new Error(`Tool "${call.name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
            TOOL_TIMEOUT_MS,
        ),
    );

    try {
        const result = await Promise.race([tool.execute(call.arguments), timeoutPromise]);
        console.error(`[loop] ${call.name} → OK (${result.length} chars)`);
        return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            result,
            isError: false,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[loop] ${call.name} → ERROR: ${message}`);
        return {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            result: `Error executing tool: ${message}`,
            isError: true,
        };
    }
}

// ---------------------------------------------------------------------------
// Main: agentic loop
// ---------------------------------------------------------------------------

/**
 * Runs the agentic loop:
 *   stream → check stop_reason → execute tools → repeat
 *
 * Returns the reason the loop exited so the caller can decide what to do.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<LoopExitReason> {
    const { provider, model, tools, system } = options;

    // Caller ke messages ka shallow copy — hum isme push karte hain
    const messages: Message[] = [...options.messages];
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        // ── 1. Model se stream lo ──────────────────────────────────────────────
        let assistantMessage: AssistantMessage | null = null;

        try {
            for await (const event of provider.stream({ messages, model, tools, ...(system ? { system } : {}) })) {
                if (event.type === "text_delta") {
                    options.onText?.(event.delta);
                } else {
                    // event.type === "done"
                    assistantMessage = event.message;
                }
            }
        } catch (err) {
            // API error / network fail / model cancelled / failed
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[loop] Stream error on turn ${turn + 1}: ${msg}`);
            return "error";
        }

        // Model ne kuch diya hi nahi — unexpected
        if (!assistantMessage) {
            console.error(`[loop] No message received from model on turn ${turn + 1}`);
            return "error";
        }

        // Turn complete callback
        options.onTurnEnd?.(assistantMessage, turn + 1);

        // History me save karo
        messages.push(assistantMessage);

        const { stop_reason } = assistantMessage;

        // ── 2. Stop reason ke hisab se decide karo ────────────────────────────

        switch (stop_reason) {
            // ✅ Model ne final answer diya — kaam khatam
            case "stop":
                return "done";

            // ⚠️  Token limit hit — response truncated, gracefully exit
            case "length":
                console.error("[loop] WARN: Model hit output token limit — response may be incomplete.");
                return "length";

            // 🔧 Tool call — execute karo aur loop continue karo
            case "toolUsage": {
                const toolCalls = assistantMessage.content.filter(
                    (b): b is ToolCallBlock => b.type === "toolCall",
                );

                // Sanity check — toolUsage lekin calls nahi, inconsistent state
                if (toolCalls.length === 0) {
                    console.error("[loop] ERROR: stop_reason=toolUsage but no tool calls found in response.");
                    return "error";
                }

                // Saare tool calls parallel execute karo
                const results = await Promise.all(
                    toolCalls.map((call) => executeTool(call, toolMap)),
                );

                // Results history me daalo aur loop continue
                messages.push(...results);
                continue;
            }

            // ❌ Unexpected stop reason
            default: {
                console.error(`[loop] ERROR: Unhandled stop_reason "${stop_reason}" on turn ${turn + 1}.`);
                return "error";
            }
        }
    }

    // MAX_TURNS hit — safety guard
    console.error(`[loop] ERROR: Agent stopped after reaching max turns (${MAX_TURNS}).`);
    return "max_turns";
}
