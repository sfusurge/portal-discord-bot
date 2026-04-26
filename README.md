# portal-discord-bot

Discord watcher bot that listens to configured channels and forwards messages to the Hacker Portal announcements ingestion API.

## What it does

- Watches only configured Discord channel IDs
- Forwards every non-bot message from those channels to the Portal API
- Mirrors message **edits** in place via `MessageUpdate` (uses `Partials.Message` so it catches edits to messages sent before the bot started)
- Sends each attachment's metadata (URL, filename, content type, size, dimensions) as a structured array — content text and attachments are kept separate
- Archives the full Discord `Message.toJSON()` payload so we can backfill later if needed
- Archives portal rows when messages are **deleted** in Discord (`MessageDelete` and `MessageBulkDelete` → portal `DELETE`, `is_archived=true`)
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

## Create/edit payload sent to Portal

```jsonc
{
  "channelId":      "string",
  "guildId":        "string",
  "messageId":      "string",
  "authorId":       "string",
  "content":        "string (may be empty if attachments[] is non-empty)",
  "timestamp":      "ISO-8601 string (Message.createdAt)",
  "editedTimestamp": "ISO-8601 | null (set on edit deliveries)",
  "attachments": [
    {
      "url":         "string",
      "filename":    "string | null",
      "contentType": "string | null",
      "sizeBytes":   "integer | null",
      "width":       "integer | null",
      "height":      "integer | null"
    }
  ],
  "rawPayload":     { /* Message.toJSON() */ },
  "idempotencyKey": "string (= messageId)"
}
```

Headers:

- `Authorization: Bearer <PORTAL_API_SECRET>`
- `X-Idempotency-Key: <messageId>`

Portal responses (consumed by `PortalClient`):

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| 201    | Created (first delivery)                                             |
| 200    | Duplicate (idempotent replay) **or** updated (edit applied)          |
| 400    | Invalid JSON / fails Zod (e.g. empty content + no attachments)       |
| 401    | Bad bearer secret                                                    |
| 403    | Portal ingest disabled — bot does **not** retry                      |
| 422    | No active channel mapping on the portal — bot does **not** retry     |
| 429 / 5xx | Retried with exponential backoff + jitter                         |

## Edit handling

- `MessageUpdate` is wired up alongside `MessageCreate`. When fired, the bot:
  - Hydrates partial messages via `.fetch()` (necessary for messages sent before the bot started — requires `Partials.Message` in the client config, already configured)
  - Skips updates with no `editedAt` (Discord fires `MessageUpdate` for embed expansion, pin/unpin, etc.)
  - Sends the same payload shape as create, with `editedTimestamp` set
- The portal applies edits in place: updates `content`, replaces the entire attachment set, sets `last_edited_at`. Edit replays with the same or older `editedTimestamp` are no-ops.

## Delete handling

`MessageDelete` and `MessageBulkDelete` are wired up alongside create/edit. When a watched message is deleted, the bot sends:

```jsonc
{
  "messageId": "string",
  "channelId": "string",
  "guildId": "string | undefined"
}
```

Headers:

- `Authorization: Bearer <PORTAL_API_SECRET>`
- `X-Idempotency-Key: delete:<messageId>`

Portal delete responses:

| Status | Meaning |
| ------ | ------- |
| `archived` | Matching announcement existed and was soft-hidden with `is_archived=true` |
| `duplicate` | Matching announcement was already archived |
| `not_found` | Portal never ingested that Discord message id; treated as successful no-op |

Delete handlers do **not** hydrate/fetch the deleted message because Discord usually cannot fetch deleted messages. They rely on partial-safe fields (`id`, `channelId`, and `guildId` when available), and filter by `DISCORD_WATCH_CHANNEL_IDS`.

## Idempotency model

- `idempotencyKey` is always `message.id` (does not change on edit).
- Network retries of a create return `200 duplicate`.
- Network retries of an edit return `200 duplicate` once the portal has stored the same `editedTimestamp` once.
- Network retries of a delete use `delete:<messageId>` and return `200 duplicate` or `200 not_found` once the portal has already handled the event.
