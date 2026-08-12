export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * In-memory per-channel / thread conversation history with a message-count cap.
 * System prompt is not stored here; backends prepend it at request time.
 */
export class ConversationMemory {
  private readonly store = new Map<string, ChatMessage[]>();

  constructor(private readonly maxMessages: number) {
    if (maxMessages < 1) throw new Error("maxMessages must be >= 1");
  }

  get(key: string): ChatMessage[] {
    return [...(this.store.get(key) ?? [])];
  }

  append(key: string, message: ChatMessage): void {
    const list = this.store.get(key) ?? [];
    list.push(message);
    while (list.length > this.maxMessages) {
      list.shift();
    }
    this.store.set(key, list);
  }

  clear(key?: string): void {
    if (key === undefined) this.store.clear();
    else this.store.delete(key);
  }
}
