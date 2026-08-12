export interface AgentRequest {
  /** Stable memory key (channel or thread id). */
  conversationKey: string;
  /** Display name for the Discord user. */
  authorDisplayName: string;
  /** User message with bot mention stripped. */
  content: string;
  /** Parent guild channel name when available (e.g. "7dtd"); for threads, the parent. */
  channelName?: string;
  /** Thread name when the message is in a thread. */
  threadName?: string;
  /** Channel topic when set (parent topic for threads). */
  channelTopic?: string | null;
  /** Guild name when available. */
  guildName?: string;
}

export interface AgentResponse {
  text: string;
}

export interface AgentBackend {
  readonly name: string;
  generate(request: AgentRequest): Promise<AgentResponse>;
}
