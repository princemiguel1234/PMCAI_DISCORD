# PMC_AI — Discord AI Assistant

PMC_AI is a Node.js ES-module Discord bot that uses Groq's `openai/gpt-oss-120b` model and Tavily Search. An Express health endpoint runs in the same process so the project can be deployed as one Render **Web Service**.

## Features

- Replies to messages that mention `@PMC_AI` in servers and responds to direct messages.
- Uses `openai/gpt-oss-120b` for text and `qwen/qwen3.8-27b` for supported image attachments through Groq Chat Completions at `https://api.groq.com/openai/v1/chat/completions`.
- Adds the speaking Discord user's username, display name, user ID, server/channel context, and actual message text to each AI request. Per-user/per-channel conversation history remains isolated.
- Downloads and validates up to five supported Discord PNG, JPEG, GIF, and WebP attachments (14 MiB total) before sending their actual image bytes to the vision model. Video and unsupported attachments are ignored; mixed supported/unsupported attachments use text-only routing.
- Searches Tavily only for explicit research/search requests and likely time-sensitive or changing information.
- Stores at most 25 user/assistant messages per channel conversation, including no more than the last 24 old messages plus the current user message in a model request.
- Serializes processing for each channel to prevent concurrent requests from racing the same history.
- Supports `/ping`, `/clear`, `/help`, and `/mode`; slash commands register automatically when the bot connects.
- Also understands “act like a robot” and “human mode” in a message directed to the bot.
- Handles message edits/deletions when the message is represented in the local history, typing indicators, long Discord replies, HTTP timeouts, temporary Groq failures, memory cleanup, and graceful shutdown.
- Uses no database or disk-based conversation storage. History and speaking mode reset on restart/redeploy/sleep.

## Requirements

- Node.js 20.11 or newer (Render selects a supported Node runtime from `package.json`).
- A Discord application/bot token.
- A Groq API key with access to `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` for image requests.
- A Tavily API key.
- A GitHub account connected to Render.

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application named `PMC_AI` (or open the existing application).
2. Open **Bot** and add a bot user if one does not exist. Copy its token and keep it private. If a token was exposed in a screenshot or chat, reset it and use the new one only in environment variables.
3. On the **Bot** page, turn on **Message Content Intent** under Privileged Gateway Intents and save changes. The code uses this intent to read the message text after a mention.
4. Open **OAuth2 → URL Generator**. Select `bot` and `applications.commands` under scopes.
5. Select only the permissions needed: **View Channels**, **Send Messages**, and **Read Message History**. To answer inside threads, also allow **Send Messages in Threads**. Do not grant Administrator.
6. Open the generated invite URL and add PMC_AI to your server.

Direct messages use the bot's normal DM access. The bot never answers its own messages and ignores ordinary server messages without a bot mention.

## 2. Obtain API keys

- **Groq:** create an API key at [Groq Console → API Keys](https://console.groq.com/keys).
- **Tavily:** create an API key at [Tavily](https://app.tavily.com/).

Text-only requests use `openai/gpt-oss-120b`; supported-image requests use `qwen/qwen3.8-27b`. `GROQ_MODEL` remains in the environment configuration for compatibility, but attachment routing deliberately uses these exact model IDs.

## 3. Local setup (optional)

```bash
npm install
cp .env.example .env
```

Edit `.env` and fill in `DISCORD_TOKEN`, `GROQ_API_KEY`, and `TAVILY_API_KEY`. Never commit `.env` or share screenshots containing secrets.

Start it with:

```bash
npm start
```

Verify the HTTP process at `http://localhost:10000/health` by default. Run the checks with:

```bash
npm test
npm run check
```

## 4. Deploy to GitHub and Render

1. Create a new GitHub repository, for example `pmc-ai-discord-bot`.
2. Upload the project files from this folder to the repository root. Do **not** upload `.env`, `node_modules`, or API keys.
3. In [Render](https://render.com/), choose **New → Web Service**, connect GitHub, then select the repository. Do not create a Static Site.
4. Use these settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
5. Add these environment variables in Render:
   - `DISCORD_TOKEN` — the bot token from Discord
   - `GROQ_API_KEY` — the Groq key
   - `GROQ_MODEL` — retained for configuration compatibility; routing uses the exact model IDs above
   - `TAVILY_API_KEY` — the Tavily key
   - `MEMORY_TTL_MINUTES` — optional, defaults to `360`
   - `MAX_CONVERSATIONS` — optional, defaults to `1000`
6. Optional during setup: set `DISCORD_GUILD_ID` to your test server's ID. PMC_AI registers commands in that one server, where they appear quickly. Remove the variable when you want globally registered slash commands; global propagation can take time. The code registers commands automatically at startup.
7. Click **Create Web Service** and check Render's Logs. Look for `Registered 4 slash commands` and `Logged in as ...`.
8. Open the deployed `https://<your-service>.onrender.com/health` URL. It should return JSON with `"status":"ok"`.

A `render.yaml` Blueprint is included with the build/start commands, health path, and environment-variable definitions. You can use it as an alternative to manually configuring the service.

## 5. Test in Discord

- In a server channel: `@PMC_AI hey, introduce yourself`.
- In a DM: send `hello`.
- Search: `@PMC_AI search for the latest Node.js LTS release and cite sources`.
- Robot style: `@PMC_AI act like a robot`.
- Return to normal: `@PMC_AI human mode`.
- Commands: `/ping`, `/help`, `/clear`, `/mode`.

`/clear` clears short-term history for the current channel/DM, which is shared by bot interactions in that channel. It does not erase messages from Discord.

## Environment variables

| Variable | Required | Default / purpose |
|---|---:|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `GROQ_API_KEY` | Yes | Groq API key |
| `GROQ_MODEL` | No | Retained for compatibility; exact text/image model routing is used |
| `TAVILY_API_KEY` | Yes | Tavily API key |
| `DISCORD_GUILD_ID` | No | Restricts slash-command registration to a test server for fast updates |
| `PORT` | No | Render supplies this; local default is `10000` |
| `GROQ_TIMEOUT_MS` | No | `45000` |
| `TAVILY_TIMEOUT_MS` | No | `15000` |
| `MEMORY_TTL_MINUTES` | No | `360` (six hours of inactivity) |
| `MAX_CONVERSATIONS` | No | `1000` memory entries/conversations maximum |

## Memory and reliability notes

- Memory is process-local and temporary, not permanent storage. A restart, deploy, instance sleep, or crash resets conversation history and per-conversation speaking mode.
- Each channel/thread/DM is a separate conversation. The prompt includes at most 24 previous messages plus the current request, with additional character limits. The stored history counts user and assistant messages separately and is capped at 25.
- Message-edit and message-delete events update/remove matching local history when Discord supplies enough message metadata. Validated image bytes are sent to the vision model for the current request only; image bytes are not retained in conversation memory. Video and unsupported files are not uploaded to Groq.
- The `/health` endpoint confirms only that the HTTP process is responding. It does not call Discord, Groq, or Tavily.
- API keys never go into source code or logs. Search result text is treated as untrusted data, and the bot does not execute code or arbitrary tools from messages or webpages.

## Render Free plan caveat

Render Free Web Services can spin down after 15 minutes without inbound traffic, and Render may restart free instances. A Discord Gateway connection alone is not a guarantee of continuous availability. When the service is asleep or restarting, PMC_AI can appear offline and short-term memory is lost. Use an appropriate always-on paid Web Service plan if you require reliable 24/7 online behavior. This project does not use a separate VPS, database, Docker, or an external keep-alive service.

## Troubleshooting

- **Bot stays offline:** check Render logs for login errors, confirm `DISCORD_TOKEN` is the current token, and check that the service is running.
- **Bot sees a mention but not the full message:** turn on **Message Content Intent** in the Discord Developer Portal and redeploy/restart.
- **Slash commands do not appear:** confirm the bot was invited with `applications.commands`, check the logs for command-registration errors, and verify `DISCORD_GUILD_ID` if using guild-scoped test commands. Global commands can take time to appear.
- **401/403 from Groq:** verify `GROQ_API_KEY` is correct and that the configured model is available to your account. Errors are not echoed to users.
- **429 or temporary AI failures:** wait and retry; Groq rate limits depend on the account and model access. PMC_AI retries one transient failure and then returns a generic message.
- **Search is unavailable:** verify `TAVILY_API_KEY` and Tavily usage limits. The bot can answer from existing knowledge when appropriate but must not claim it verified the current information.
- **Health says OK but bot does not reply:** `/health` checks the HTTP process only. Inspect Render logs and Discord bot status separately.

## Project files

```text
.
├── index.js
├── package.json
├── render.yaml
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── ai.js
│   ├── bot.js
│   ├── config.js
│   ├── format.js
│   ├── memory.js
│   └── search.js
└── test/
    ├── attachments.test.js
    └── memory.test.js
```
