# Telegram Architecture

## 1. Multi-bot, not one bot

Every tenant connects **its own** bot (`@AnorCafeBot`, `@BarberHouseBot`). Customers
must feel they are talking to the business, not to a platform. Consequences:

- Bot tokens are tenant data, stored **encrypted** (AES-256-GCM via `SecretVault`),
  never returned to any client — the admin UI shows `••••••:AAH…xyz`.
- Webhook routing must resolve _which tenant_ before any business logic runs.
- Rate limits are per bot; queue keys include the bot id.

## 2. Webhook routing

```
Telegram ──POST /v1/telegram/webhook/:webhookSecret
             │  header X-Telegram-Bot-Api-Secret-Token must match
             ▼
     TelegramGatewayController   (@Public — no session exists yet)
             │  prisma.$system('telegram-gateway') → resolve bot by webhookSecret
             ▼
     ProcessedWebhook.create({ source:'telegram', key: `${botId}:${update_id}` })
             │  unique violation ⇒ duplicate ⇒ 200 OK, stop        ← idempotency
             ▼
     tenantContext.run({ tenantId }, () => TelegramUpdateRouter.route(update))
             │
   ┌─────────┴──────────┬──────────────┬─────────────────┐
 commands            callbacks       messages         web_app_data
 /start /menu …    inline buttons   → Conversation    → order/booking
```

We answer Telegram within ~1s and do real work on the queue: the controller enqueues, the
worker processes. Telegram retries aggressively, which is exactly why `ProcessedWebhook`
is checked first.

The secret path segment is a 32-byte random value per bot, so guessing a tenant's webhook
URL is infeasible; the `X-Telegram-Bot-Api-Secret-Token` header is a second factor.

## 3. Bot ↔ customer identity

`/start` (optionally `/start ref_<code>` or `/start table_<id>`) does:

1. resolve tenant from the bot,
2. upsert `Customer` on `(tenantId, telegramUserId)`,
3. update `lastActivityAt`, capture `languageCode` if the customer has no language yet,
4. emit `customer.created` on first contact,
5. render the menu from **enabled modules** — no dead buttons.

```
🛍 Katalog   📅 Bron qilish   📦 Buyurtmalarim
⭐ Bonuslarim  📍 Filiallar    💬 Operator     👤 Profil
```

## 4. Mini App authentication

The Mini App receives `window.Telegram.WebApp.initData` — a signed query string. The
client is never trusted:

```
POST /v1/shop/auth/telegram { initData, tenantSlug }
  1. resolve tenant + bot token (system context)
  2. secret = HMAC_SHA256("WebAppData", botToken)
     expected = HMAC_SHA256(secret, dataCheckString)   ← sorted, hash removed
  3. timingSafeEqual(expected, hash)          else 401 TELEGRAM_SIGNATURE_INVALID
  4. auth_date within 24h                     else 401 TELEGRAM_INITDATA_EXPIRED
  5. upsert Customer → issue customer JWT (aud:"customer", tenantId, customerId)
```

Implemented in `packages/telegram/src/init-data.ts` as a pure, unit-tested function.
`timingSafeEqual` is used deliberately. Telegram's newer Ed25519 third-party validation
is supported behind a flag for future off-platform use.

## 5. Sending

`TelegramSender` wraps the Bot API with a per-bot token-bucket limiter (30 msg/s global,
~20/min per chat), retries on `429` honouring `retry_after`, and marks a bot
`status: BLOCKED` when Telegram reports the bot was blocked by the user — so the
notification engine stops wasting sends and the CRM shows the customer as unreachable.

## 6. Connecting a bot (onboarding step 4)

Owner pastes a BotFather token → API validates with `getMe`, encrypts and stores it,
generates the webhook secret, calls `setWebhook` with `secret_token` and
`allowed_updates`, calls `setMyCommands` and `setChatMenuButton` pointing at the Mini App,
then stores `botUsername`. Every step is reported in the UI; failures are actionable
("token is valid but the webhook could not be set — is the public URL reachable?").
In local development, `TELEGRAM_MODE=polling` runs long-polling so no tunnel is needed.
