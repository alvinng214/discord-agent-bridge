import type { AgentBackend, AgentRequest, AgentResponse } from "./backend.js";

/**
 * Extension point for a future Grok Bot Discord/Channels-style inbound API.
 * Phase 1 intentionally does not invent or call any such API.
 * North Star: this class becomes the real connector once that API is documented.
 */
export class GrokBotBackend implements AgentBackend {
  readonly name = "grok-bot";

  async generate(_request: AgentRequest): Promise<AgentResponse> {
    throw new Error(
      "GrokBotBackend is not implemented — awaiting Grok Bot Channels-style inbound API. " +
        "Use AGENT_BACKEND=openai with an OpenAI-compatible endpoint for Phase 1. " +
        "This repo is the community Discord connector for that future backend.",
    );
  }
}
