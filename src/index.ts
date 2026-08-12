import "dotenv/config";
import type { AgentBackend } from "./agent/backend.js";
import { GrokBotBackend } from "./agent/grokBot.js";
import { OpenAICompatibleBackend } from "./agent/openaiCompatible.js";
import { loadConfig } from "./config.js";
import { startBot } from "./discord/bot.js";

function createBackend(config: ReturnType<typeof loadConfig>): AgentBackend {
  if (config.agentBackend === "grok-bot") {
    return new GrokBotBackend();
  }

  return new OpenAICompatibleBackend({
    apiBaseUrl: config.apiBaseUrl!,
    apiKey: config.apiKey!,
    model: config.model!,
    systemPrompt: config.systemPrompt,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    memoryMaxMessages: config.memoryMaxMessages,
    braveApiKey: config.braveApiKey,
    tavilyApiKey: config.tavilyApiKey,
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(
    `[bridge] backend=${config.agentBackend}` +
      (config.model ? ` model=${config.model}` : "") +
      (config.apiBaseUrl ? ` base=${config.apiBaseUrl}` : "") +
      ` soul=${config.systemPromptFile}`,
  );
  const backend = createBackend(config);
  await startBot(config, backend);
}

main().catch((err) => {
  console.error("[bridge] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
