# discord-agent-bridge

Open-source **Discord ↔ AI agent bridge**: a long-running gateway bot that authenticates messages, routes them to a pluggable `AgentBackend`, and replies in Discord.

Built to migrate a Discord gaming helper off Hermes without copying proprietary Hermes source.

> **Phase 1 status:** gateway bot + Hermes-like access control + OpenAI-compatible backend (memory, optional Brave/Tavily tools) + `GrokBotBackend` stub. No real Grok Bot Channels API client, no multi-tenant SaaS, no Azure Functions hosting.

## Architecture

```mermaid
flowchart LR
  D[Discord Gateway] --> B[Bridge]
  B --> A[Access control]
  A --> R[Rate limit]
  R --> M[AgentBackend]
  M --> O[OpenAICompatibleBackend]
  M --> G[GrokBotBackend stub]
  O --> T[Optional web search]
  O --> Mem[Per-channel memory]
  M --> B
  B --> D
```

## Requirements

- Node.js **20+**
- A Discord bot with **Message Content Intent** enabled
- An OpenAI-compatible API key (xAI, OpenAI, OpenRouter, etc.)

## Discord Developer Portal setup

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → **Bot**.
2. Copy the bot token → `DISCORD_BOT_TOKEN` (never commit it).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.  
   (Server Members Intent is also requested by this client for role checks on large guilds.)
4. OAuth2 → URL Generator → scopes: `bot`.  
   Permissions: View Channels, Send Messages, Read Message History.
5. Invite the bot to a **private** test server first. Keep the bot **private** until allowlists are verified.

## Quick start

```bash
cp .env.example .env
# edit .env: DISCORD_BOT_TOKEN, API_*, allowlists

npm install
npm test
npm run build
npm start
# or: npm run dev
```

Docker:

```bash
cp .env.example .env   # fill in secrets
docker compose up --build
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_ALLOW_ALL_USERS` | no | Default `false`. If `true`, skip user/role allowlists |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user IDs |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role IDs; empty = no role gate |
| `DISCORD_FREE_RESPONSE_CHANNELS` | no | Channel IDs where @mention is not required |
| `DISCORD_REQUIRE_MENTION` | no | Default `true` outside free-response channels |
| `DISCORD_HOME_CHANNEL` | no | Optional home channel (logged at startup) |
| `AGENT_BACKEND` | no | `openai` (default) or `grok-bot` (stub) |
| `API_BASE_URL` | if openai | e.g. `https://api.x.ai/v1` or `https://api.openai.com/v1` |
| `API_KEY` | if openai | Provider API key |
| `MODEL` | if openai | Model id |
| `SYSTEM_PROMPT_FILE` | no | Default `SOUL.md` |
| `TEMPERATURE` | no | Default `0.7` |
| `MAX_TOKENS` | no | Default `1024` |
| `MEMORY_MAX_MESSAGES` | no | Default `20` (per channel/thread key) |
| `RATE_LIMIT_PER_USER` | no | Default `5` / window |
| `RATE_LIMIT_WINDOW_MS` | no | Default `60000` |
| `BRAVE_API_KEY` | no | Enables Brave web search tool |
| `TAVILY_API_KEY` | no | Enables Tavily web search tool |

Access control fails closed: if `DISCORD_ALLOW_ALL_USERS` is false and both allowlists are empty, nobody is served.

Web search tools are registered **only** when at least one of `BRAVE_API_KEY` / `TAVILY_API_KEY` is set.

## Scripts

| Script | Action |
|--------|--------|
| `npm run dev` | Run with `tsx watch` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Vitest |
| `npm run build` | `tsc` → `dist/` |

## Security

- **Never commit** `.env`, tokens, or API keys. `.gitignore` excludes `.env`.
- Keep the Discord application **private** until you trust your allowlists.
- Prefer a private ops server for the first cutover.
- The bot ignores other bots and itself; replies are split near 1900 characters.

## Hermes migration

1. Map Hermes allowlists → `DISCORD_ALLOWED_USERS` / `DISCORD_ALLOWED_ROLES` / `DISCORD_FREE_RESPONSE_CHANNELS`.
2. Copy your soul / system prompt into `SOUL.md` (or set `SYSTEM_PROMPT_FILE`). Do **not** copy proprietary Hermes source code.
3. Point `API_BASE_URL` / `API_KEY` / `MODEL` at the same OpenAI-compatible provider, or switch to xAI / OpenRouter.
4. Stop Hermes’ Discord listener, start this bridge as an always-on process (`npm start` or Docker), smoke-test in `DISCORD_HOME_CHANNEL`.

See [docs/PLAN.md](docs/PLAN.md) for Phase 1 details and Phase 2 notes (real Grok Bot backend later).

## License

MIT — see [LICENSE](LICENSE).
