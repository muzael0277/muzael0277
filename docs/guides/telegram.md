# Telegram integration

Telegram is the primary surface for this product: customers browse, order and book
inside Telegram, and staff get notified there. Two pieces are involved — a **bot** per
tenant, and a **Mini App** that the bot opens.

## Multi-bot by design

Every tenant connects its own bot. Anor Cafe's customers talk to `@anorcafe_bot`, not
to a shared platform bot. That means:

- Bot tokens are **not** environment variables. Each is stored per tenant, encrypted
  with AES-256-GCM in the integration vault (`packages/database/src/secret-vault.ts`),
  and never returned to any client — invariant I7.
- Incoming updates must be resolved to a tenant _before_ any tenant context exists.
  The webhook handler does this in system context, then enters a normal tenant scope.

## Connecting a bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, follow the
   prompts, and copy the token.
2. In the admin dashboard go to **Telegram → Connect** and paste it.
3. The API calls `getMe` to validate the token before storing anything, saves it
   encrypted, generates two random secrets, and registers the webhook.

Under the hood (`POST /v1/t/:tenantId/telegram/connect`) two secrets are generated:

| Secret          | Length   | Purpose                                                              |
| --------------- | -------- | -------------------------------------------------------------------- |
| `webhookSecret` | 24 bytes | Goes in the URL path — the bot is identified by an unguessable URL   |
| `headerSecret`  | 16 bytes | Sent to Telegram as its secret token and echoed back on every update |

The webhook URL is `${TELEGRAM_WEBHOOK_BASE_URL}/v1/telegram/webhook/<webhookSecret>`.

## Polling vs webhook

| `TELEGRAM_MODE` | Use                                                          |
| --------------- | ------------------------------------------------------------ |
| `polling`       | Local development. No public URL, no tunnel, no ngrok        |
| `webhook`       | Production. `TELEGRAM_WEBHOOK_BASE_URL` must be public HTTPS |
| `disabled`      | CI and any environment that must not talk to Telegram at all |

Switching modes is a restart, not a migration: on connect the service either registers
a webhook or starts long polling, depending on the mode.

## How an update is authenticated

`POST /v1/telegram/webhook/:secret` is a public route, so it defends itself:

1. **Resolve the bot by the path secret.** An unknown secret gets `200 OK` — the same
   response a handled update gets. Returning 404 would let anyone enumerate which
   tenants exist by probing paths.
2. **Compare the `x-telegram-bot-api-secret-token` header** against the stored
   `headerSecret`, with a constant-time comparison. A mismatch also returns `200 OK`.
3. **Skip suspended and deleted tenants.**
4. **Deduplicate on `(botId, update_id)`** via a `ProcessedWebhook` row, before any
   side effect. Telegram retries aggressively; the unique-constraint violation _is_ the
   duplicate signal.
5. Only then does the update enter a tenant context and reach the router.

Steps 1–4 all happen outside tenant context, in system scope. That is one of the few
sanctioned places where the tenant guard is bypassed, and it is the reason those steps
read only from bot-identity tables.

## Mini App authentication

The Mini App receives `initData` from Telegram's WebApp bridge and posts it to
`POST /v1/shop/auth/telegram` along with a tenant slug.

The server recomputes the HMAC-SHA256 over the sorted data-check string, keyed by
`HMAC("WebAppData", botToken)`, and compares it in constant time
(`packages/telegram/src/init-data.ts`). It also rejects `auth_date` older than the
allowed window, so a captured `initData` string cannot be replayed indefinitely.

**The client's claim about who it is carries no weight.** The user id comes out of the
verified payload, never out of a request field. Everything after that is an ordinary
customer session scoped to one tenant.

Locally the Mini App also runs in a plain browser at http://localhost:3002 — the bridge
degrades to a mock so you can develop without Telegram. That path is development-only
and refuses to authenticate.

## Testing without a real bot

The demo tenants do not need one. `pnpm db:seed` creates them with the bot disconnected
and the Mini App reachable directly, so the whole catalogue → cart → checkout → booking
flow works in a browser.

To test a real bot end to end you need a public HTTPS URL for the webhook. Any tunnel
works; set `TELEGRAM_WEBHOOK_BASE_URL` to the tunnel's origin and
`TELEGRAM_MODE=webhook`, then reconnect the bot so the URL is re-registered.

Telegram's own `setWebhook` requires a valid certificate; a self-signed one will be
rejected silently, which looks exactly like "my bot does nothing".

## Sending messages

Outbound messages go through the notification module and the queue, never inline in a
request handler. A Telegram API call that blocks a checkout request turns a slow
Telegram into a slow checkout. Templates live in the database per tenant, in all three
languages, and are seeded for the demo businesses.

## Rate limits

Telegram allows roughly 30 messages per second per bot, and about 20 per minute to one
group. Bulk sends go through the queue with `WORKER_CONCURRENCY` bounding throughput;
a broadcast to a large customer list is paced rather than fired at once.

## Where the code is

| Path                                 | Contains                                |
| ------------------------------------ | --------------------------------------- |
| `packages/telegram/src/client.ts`    | Bot API client                          |
| `packages/telegram/src/init-data.ts` | `initData` HMAC verification            |
| `apps/api/src/modules/telegram/`     | Controllers, bot service, update router |
| `apps/miniapp/src/lib/telegram.ts`   | WebApp bridge, main button, haptics     |

Design rationale: `docs/architecture/07-telegram.md`.
