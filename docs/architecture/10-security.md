# Security

## 1. Authentication

- Passwords: **argon2id** (64 MB, t=3, p=4). Never MD5/SHA/bcrypt-with-low-cost.
- Access token: JWT, 15 min, `aud: "staff" | "customer"`, signed HS256 with a key that is
  distinct from the refresh key.
- Refresh token: 256-bit random, **stored hashed** (SHA-256), 30 days, rotated on every
  use. Reuse of a consumed refresh token revokes the entire family and writes an
  `AuditLog` — that is how stolen-token replay is detected.
- Admin app holds the refresh token in an `httpOnly; Secure; SameSite=Strict` cookie; the
  access token stays in memory. The Mini App uses `Authorization: Bearer` (no cookie,
  because it runs inside Telegram's webview).
- Login throttling: 5 attempts / 15 min per (email, IP), exponential lockout, generic
  error message (no user enumeration).

## 2. Authorization

Tenant isolation (`02`) and RBAC (`03`). Two properties worth repeating:
routes without an explicit permission decorator **fail at boot**, and `findUnique` is
rewritten to include the tenant filter so a leaked id is not a capability.

## 3. Input & output

- Every request body/query/param passes a zod schema; unknown keys are stripped.
- Prisma parameterises everything; `$queryRawUnsafe` is banned by an ESLint rule.
- No HTML is rendered from user input; React escapes by default and
  `dangerouslySetInnerHTML` is lint-banned.
- File uploads: extension + MIME + **magic-byte** check, size caps, images re-encoded
  through sharp (which strips EXIF and any embedded payload), random storage keys,
  served from a separate origin, `Content-Disposition: attachment` for non-images.

## 4. Secrets

- Never in the repository. `.env.example` lists names only.
- Third-party credentials: AES-256-GCM in `SecretVault`, keyed by
  `SECRETS_ENCRYPTION_KEY` (32 bytes, rotatable via `keyVersion` on each record).
- Logger runs a redaction pass over `password`, `token`, `secret`, `authorization`,
  `initData`, `card`, `signature` at any depth.

## 5. Webhooks

- Inbound: signature verification before any parsing that has side effects; replay
  protection through `ProcessedWebhook`; raw body preserved for HMAC.
- Outbound: `X-BizBot-Signature: t=<ts>,v1=<hmac>` over `timestamp.body`, 5-minute
  tolerance, exponential retry, deliveries logged.

## 6. Transport & headers

HTTPS only, HSTS, `helmet` defaults, strict CSP on the admin app, CORS allow-list
(admin origin, Mini App origin, `*.telegram.org` for the Mini App bridge only).
CSRF: cookie auth is refresh-only and `SameSite=Strict`; all mutating endpoints use the
Bearer access token, so there is no ambient-authority write path.

## 7. Rate limiting

Redis token buckets: auth 5/15 min per IP · API 300/min per tenant · Mini App 60/min per
customer · Telegram per bot · payment webhooks per integration (generous — never throttle
a PSP into retry storms).

## 8. Auditing

`AuditLog(tenantId, actorUserId, action, entityType, entityId, before, after, ip,
userAgent, createdAt)` — append-only (no update/delete grant for the app role), written
for: login/logout/failed login, member invited/role changed/removed, integration or bot
credentials changed, price changed, order/booking status changed, refunds, loyalty
adjustments, settings changes, every platform-admin cross-tenant read.

## 9. Dependencies & CI

`pnpm audit` and CodeQL in CI; lockfile committed; Renovate for updates; Docker images
pinned by digest and running as a non-root user.

## 10. Data protection

Uzbek personal-data law expects citizens' data to be stored in-country — hosting is
planned accordingly (see `13-technical-risks.md` R7). Customer export and delete
(`customer:export`, right-to-erasure) anonymise rather than hard-delete rows referenced by
financial records, preserving accounting integrity.
