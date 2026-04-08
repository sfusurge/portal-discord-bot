# portal-discord-bot

Discord watcher bot that listens to configured channels and forwards messages to the Hacker Portal announcements ingestion API.

## What it does

- Watches only configured Discord channel IDs
- Forwards every non-bot message from those channels to Portal API
- Includes deterministic idempotency key (`message.id`) to support dedupe
- Retries transient API failures with capped exponential backoff + jitter
- Supports `--dry-run` startup for safe validation

## Setup

1. Install dependencies:
   - `npm install`
2. Copy env template:
   - `cp .env.example .env` (or create `.env` manually on Windows)
3. Fill required values in `.env`

## Environment variables

- `DISCORD_BOT_TOKEN`: Discord bot token
- `DISCORD_WATCH_CHANNEL_IDS`: comma-separated channel IDs to ingest from
- `PORTAL_API_URL`: Portal endpoint (e.g. `https://portal.sfusurge.com/api/webhooks/discord`)
- `PORTAL_API_SECRET`: shared bearer secret expected by Portal API
- `PORTAL_API_TIMEOUT_MS`: request timeout in ms
- `PORTAL_MAX_RETRIES`: number of retries after initial request
- `PORTAL_RETRY_BASE_DELAY_MS`: retry base backoff delay in ms
- `PORTAL_RETRY_MAX_DELAY_MS`: maximum retry delay cap in ms
- `LOG_LEVEL`: `trace|debug|info|warn|error|fatal`

## Run

- Development: `npm run dev`
- Build: `npm run build`
- Start built app: `npm run start`
- Dry-run: `node dist/index.js --dry-run`

## Payload contract sent to Portal

```json
{
  "channelId": "string",
  "guildId": "string",
  "messageId": "string",
  "authorId": "string",
  "content": "string",
  "timestamp": "ISO-8601 string",
  "idempotencyKey": "string"
}
```

Headers:

- `Authorization: Bearer <PORTAL_API_SECRET>`
- `X-Idempotency-Key: <messageId>`
