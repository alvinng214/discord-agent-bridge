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
  /**
   * Optional delivery hook used by GrokBotBackend so POST /internal/reply
   * can send the Discord message (split/~1900) before generate() resolves.
   */
  deliverReply?: (text: string) => Promise<void>;
  /** The earlier Discord message this one replies to, when the user used Discord's reply. */
  replyTo?: ReplyContext;
}

export interface ReplyContext {
  authorDisplayName: string;
  isBot: boolean;
  createdAt: string;
  content: string;
}

export interface AgentResponse {
  text: string;
  /** True when the backend already posted to Discord (skip a second send). */
  delivered?: boolean;
}

export interface AgentBackend {
  readonly name: string;
  generate(request: AgentRequest): Promise<AgentResponse>;
}
