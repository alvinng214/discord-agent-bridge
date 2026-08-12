import type { AgentBackend, AgentRequest, AgentResponse } from "./backend.js";

/**
 * Extension point for a future Grok Bot Channels API integration.
 * Phase 1 intentionally does not invent or call any such API.
 */
export class GrokBotBackend implements AgentBackend {
  readonly name = "grok-bot";

  async generate(_request: AgentRequest): Promise<AgentResponse> {
    throw new Error(
      "GrokBotBackend is not implemented — awaiting Grok Bot Channels API. " +
        "Use AGENT_BACKEND=openai with an OpenAI-compatible endpoint for Phase 1.",
    );
  }
}
