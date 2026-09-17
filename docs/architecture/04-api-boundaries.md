# API Boundaries

## 1. Surfaces

All under `/v1`. The surface determines the auth strategy, and each has its own guard chain.

| Prefix                                          | Audience | Auth                       | Guards                                      |
| ----------------------------------------------- | -------- | -------------------------- | ------------------------------------------- |
| `/v1/auth/*`                                    | anyone   | none / refresh cookie      | rate limit (strict)                         |
| `/v1/me`, `/v1/tenants`                         | staff    | staff JWT                  | `JwtAuthGuard`                              |
| `/v1/t/:tenantId/*`                             | staff    | staff JWT                  | `Jwt` → `Tenant` → `Permissions` → `Module` |
| `/v1/shop/*`                                    | customer | customer JWT               | `CustomerAuthGuard` → `Module`              |
| `/v1/public/:tenantSlug/*`                      | anyone   | none                       | cached, read-only                           |
| `/v1/telegram/webhook/:secret`                  | Telegram | secret path + header token | signature + idempotency                     |
| `/v1/payments/webhook/:provider/:integrationId` | PSP      | provider signature         | signature + idempotency                     |
| `/v1/platform/*`                                | us       | staff JWT + `platformRole` | `PlatformGuard`                             |
| `/health`, `/readiness`, `/metrics`             | infra    | none / internal            | —                                           |

Keeping the tenant in the **path** (`/v1/t/:tenantId/...`) rather than only a header makes
every log line, trace and access-log entry self-describing, and makes a missing tenant a
routing error rather than a silent default.

## 2. Response envelope

Success is the resource, unwrapped. Lists are:

```json
{ "data": [...], "meta": { "total": 142, "page": 1, "pageSize": 20, "hasMore": true } }
```

Errors are always:

```json
{
  "error": {
    "code": "BOOKING_SLOT_TAKEN",
    "message": "Bu vaqt band qilingan.",
    "details": { "resourceId": "…" },
    "requestId": "01J…"
  }
}
```

`code` is a stable machine string (clients switch on it), `message` is already localised
to the request's `Accept-Language`. Error codes live in `packages/shared/errors.ts` so
frontend and backend cannot drift.

## 3. Conventions

- **Validation** — zod schemas in `packages/contracts`, shared with the frontends, applied
  by a `ZodValidationPipe`. One definition, both sides.
- **Pagination** — `?page=&pageSize=` (max 100) for admin tables; opaque `?cursor=` for
  Mini App infinite scroll. Never unbounded.
- **Filtering/sorting** — explicit allow-lists per endpoint. No "pass any Prisma `where`
  from the client" — that is a tenant-isolation hole and a query-plan hazard.
- **Idempotency** — `POST /orders`, `POST /bookings` and `POST /payments` accept
  `Idempotency-Key`. Same key + same body → the original response; same key + different
  body → `409 IDEMPOTENCY_KEY_REUSED`.
- **Concurrency** — mutable aggregates (`Order.status`, `Booking`) accept an optional
  `If-Match: <version>`; mismatch → `409 STALE_WRITE`.
- **Rate limits** — per IP for auth, per tenant for the API, per bot for Telegram.
- **Versioning** — the `/v1` prefix is the contract. Additive changes only within a
  version; breaking changes get `/v2` and an overlap window.

## 4. Public API for tenants (Phase 4)

The same controllers, authenticated by `ApiKey` instead of a session, scoped to one
tenant and one permission set. Because permissions and tenant scoping are already guards
rather than controller code, this is an auth strategy — not a second API.

## 5. Real-time

Socket.IO namespaced per tenant (`/rt`, room `tenant:<id>`), joined only after the same
JWT + membership check as REST. Events pushed: `order.created`, `order.status_changed`,
`booking.created`, `message.received`. Everything else polls — real-time where it earns
its complexity, not everywhere.
