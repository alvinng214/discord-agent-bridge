import type { AgentBackend, AgentRequest, AgentResponse } from "./backend.js";
import type { ChatMessage, ToolCall } from "./memory.js";
import { ConversationMemory } from "./memory.js";
import {
  createWebSearchProviders,
  runWebSearchTool,
  webSearchToolDefinitions,
  type WebSearchProvider,
} from "./tools/webSearch.js";

export interface OpenAICompatibleOptions {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  memoryMaxMessages: number;
  braveApiKey?: string | null;
  tavilyApiKey?: string | null;
  fetchImpl?: typeof fetch;
  maxToolRounds?: number;
}

interface ChatCompletionChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string | null;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: { message?: string };
}

export class OpenAICompatibleBackend implements AgentBackend {
  readonly name = "openai-compatible";
  private readonly memory: ConversationMemory;
  private readonly providers: WebSearchProvider[];
  private readonly fetchImpl: typeof fetch;
  private readonly maxToolRounds: number;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.memory = new ConversationMemory(opts.memoryMaxMessages);
    this.providers = createWebSearchProviders({
      braveApiKey: opts.braveApiKey,
      tavilyApiKey: opts.tavilyApiKey,
    });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxToolRounds = opts.maxToolRounds ?? 3;
  }

  async generate(request: AgentRequest): Promise<AgentResponse> {
    const userLine = `${request.authorDisplayName}: ${request.content}`;
    this.memory.append(request.conversationKey, { role: "user", content: userLine });

    const messages: ChatMessage[] = [
      { role: "system", content: this.opts.systemPrompt },
      ...this.memory.get(request.conversationKey),
    ];

    const tools = webSearchToolDefinitions(this.providers);
    let rounds = 0;

    while (rounds < this.maxToolRounds) {
      rounds += 1;
      const data = await this.chatCompletions(messages, tools.length > 0 ? tools : undefined);
      const choice = data.choices?.[0];
      const message = choice?.message;
      if (!message) {
        throw new Error("OpenAI-compatible API returned no choices");
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          let toolResult: string;
          if (call.function.name === "web_search") {
            toolResult = await runWebSearchTool(this.providers, call.function.arguments);
          } else {
            toolResult = JSON.stringify({ error: `unknown tool: ${call.function.name}` });
          }
          messages.push({
            role: "tool",
            content: toolResult,
            tool_call_id: call.id,
            name: call.function.name,
          });
        }
        continue;
      }

      const text = (message.content ?? "").trim();
      if (!text) {
        throw new Error("OpenAI-compatible API returned empty content");
      }
      this.memory.append(request.conversationKey, { role: "assistant", content: text });
      return { text };
    }

    throw new Error("Exceeded max tool rounds without a final assistant reply");
  }

  private async chatCompletions(
    messages: ChatMessage[],
    tools?: unknown[],
  ): Promise<ChatCompletionResponse> {
    const base = this.opts.apiBaseUrl.replace(/\/+$/, "");
    const url = `${base}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      temperature: this.opts.temperature,
      max_tokens: this.opts.maxTokens,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as ChatCompletionResponse;
    if (!res.ok) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`OpenAI-compatible API error: ${msg}`);
    }
    return data;
  }
}
