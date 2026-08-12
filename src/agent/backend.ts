export interface AgentRequest {
  /** Stable memory key (channel or thread id). */
  conversationKey: string;
  /** Display name for the Discord user. */
  authorDisplayName: string;
  /** User message with bot mention stripped. */
  content: string;
  /** Guild text/thread channel name when available (e.g. "7dtd"). */
  channelName?: string;
  /** Channel topic when set. */
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
