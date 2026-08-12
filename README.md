# discord-agent-bridge

Open-source **Discord ↔ Grok Bot connector** for anyone who uses Discord (instead of Slack/Teams) to talk to and work with Grok Bots — individuals and small teams.

The bridge handles Discord auth, routing, and reply UX. **Persona, tools, and routines live in the Grok Bot** (or in your `SYSTEM_PROMPT_FILE`), not in this repo. A team assistant or a gaming helper are examples; this project stays general.

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

### North Star vs Phase 1

| | |
|--|--|
| **North Star** | Real `GrokBotBackend` once Grok Bot exposes a Discord/Channels-style inbound API — this repo is the community connector for that. |
| **Phase 1 (today)** | Runnable `OpenAICompatibleBackend` (xAI / OpenAI / OpenRouter) + team-friendly access control + `GrokBotBackend` stub. No invented Grok Bot API, no multi-tenant SaaS, no Azure Functions hosting. |

## Requirements

- Node.js **20+**
- A Discord bot with **Message Content Intent** enabled
- An OpenAI-compatible API key for Phase 1 (xAI, OpenAI, OpenRouter, etc.)

## Discord Developer Portal setup

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → **Bot**.
2. Copy the bot token → `DISCORD_BOT_TOKEN` (never commit it).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. OAuth2 → URL Generator → scopes: `bot`.  
   Permissions: View Channels, Send Messages, Read Message History.
5. Invite to a **private** test server (or enable DMs — see env below). Keep the bot **private** until allowlists are verified.

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

Optional personas (copy or point `SYSTEM_PROMPT_FILE` at them):

- [`examples/team-assistant/SOUL.md`](examples/team-assistant/SOUL.md) — small-team Discord assistant
- [`examples/gaming-helper/SOUL.md`](examples/gaming-helper/SOUL.md) — domain example only

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
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild IDs; empty = any guild |
| `DISCORD_ALLOW_DMS` | no | Default `false`. Allow DM conversations with the bot |
| `DISCORD_DM_ONLY` | no | Default `false`. Ignore all guild messages |
| `DISCORD_FREE_RESPONSE_CHANNELS` | no | Channel IDs where @mention is not required |
| `DISCORD_REQUIRE_MENTION` | no | Default `true` outside free-response channels (DMs never require mention) |
| `DISCORD_HOME_CHANNEL` | no | Optional home channel (logged at startup) |
| `AGENT_BACKEND` | no | `openai` (Phase 1 default) or `grok-bot` (stub / North Star) |
| `API_BASE_URL` | if openai | e.g. `https://api.x.ai/v1` or `https://api.openai.com/v1` |
| `API_KEY` | if openai | Provider API key |
| `MODEL` | if openai | Model id |
| `SYSTEM_PROMPT_FILE` | no | Default `SOUL.md` (neutral); swap for your agent persona |
| `TEMPERATURE` | no | Default `0.7` |
| `MAX_TOKENS` | no | Default `1024` |
| `MEMORY_MAX_MESSAGES` | no | Default `20` (per channel/thread key) |
| `RATE_LIMIT_PER_USER` | no | Default `5` / window |
| `RATE_LIMIT_WINDOW_MS` | no | Default `60000` |
| `BRAVE_API_KEY` | no | Enables Brave web search tool |
| `TAVILY_API_KEY` | no | Enables Tavily web search tool |

Access control fails closed: if `DISCORD_ALLOW_ALL_USERS` is false and both user/role allowlists are empty, nobody is served.

Web search tools are registered **only** when at least one of `BRAVE_API_KEY` / `TAVILY_API_KEY` is set (Phase 1 OpenAI-compatible path).

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
- Prefer a private server (or DM-only personal use) for the first run.
- The bot ignores other bots and itself; replies are split near 1900 characters.

## Migrating from another Discord agent host

1. Map allowlists → `DISCORD_ALLOWED_USERS` / `DISCORD_ALLOWED_ROLES` / `DISCORD_ALLOWED_GUILDS` / `DISCORD_FREE_RESPONSE_CHANNELS`.
2. Point `SYSTEM_PROMPT_FILE` at your soul/instructions (or copy into `SOUL.md`). Keep proprietary host code out of this repo.
3. Use `AGENT_BACKEND=openai` with your OpenAI-compatible provider until the real Grok Bot inbound API lands.
4. Run as an always-on process (`npm start` or Docker); smoke-test in `DISCORD_HOME_CHANNEL` or a DM.

See [docs/PLAN.md](docs/PLAN.md) for the living Phase 1 plan and Phase 2 notes (`GrokBotBackend`).

## License

MIT — see [LICENSE](LICENSE).
