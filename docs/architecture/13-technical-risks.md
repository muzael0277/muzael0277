# Technical Risks

| # | Risk | Impact | Mitigation | Status |
|---|---|---|---|---|
| R1 | **Cross-tenant leak** — one missing `WHERE tenantId` | Company-ending | 4 defence layers (`02`); Prisma extension fails closed; composite FKs; isolation test suite; RLS in Phase 7 | Mitigated |
| R2 | **Double booking** under concurrency | Angry customers, lost trust | Per-resource-day lock row + re-check inside the tx + concurrency test; GiST exclusion constraint next | Mitigated |
| R3 | **Payment webhook replay** → double loyalty / double completion | Financial loss | `ProcessedWebhook` + idempotent state machine + amount verification + replay test | Mitigated |
| R4 | **Price manipulation** from the client | Financial loss | Server recomputes every total; client prices are ignored entirely; pricing test | Mitigated |
| R5 | **Telegram rate limits** on broadcasts (30 msg/s) | Failed campaigns, bot ban | Per-bot token bucket, BullMQ pacing, `429` backoff honouring `retry_after`, blocked-user handling | Mitigated |
| R6 | **Bot token compromise** — a stolen token lets an attacker impersonate the business | Severe tenant damage | AES-256-GCM at rest, never returned to clients, masked in UI, rotation flow, audit on change | Mitigated |
| R7 | **Data residency** — Uzbek law expects citizens' personal data stored in-country | Legal/regulatory | Deployment targets in-country hosting; no PII in third-party services by default; storage adapter is S3-compatible so the provider is swappable | Planned |
| R8 | **Multi-bot webhook scaling** — N tenants × M updates on one endpoint | Latency, dropped updates | Enqueue-and-ack in <1s, worker fan-out, per-bot queue keys, horizontal workers | Mitigated |
| R9 | **`Int` overflow on money** aggregates | Corrupt reporting | `BigInt` for accumulators, `Int` for line amounts; documented in ADR-0006 | Mitigated |
| R10 | **Timezone bugs** in bookings | Wrong appointment times | UTC storage, tz library at the edges, tenant timezone explicit, no fixed offsets | Mitigated |
| R11 | **JSONB over-use** — everything becomes untyped | Unqueryable data, silent corruption | JSONB only for: genuinely open config, custom fields, snapshots, rules DSLs. Each has a zod schema validated on write | Controlled |
| R12 | **Modular monolith drifting into a big ball of mud** | Velocity collapse | Enforced import boundaries (ESLint), no cross-domain repository access, events for "and also" relationships | Controlled |
| R13 | **Prisma extension bypassed** by a raw query | Leak | `$queryRawUnsafe` lint-banned; raw SQL requires an explicit tenant predicate and review | Controlled |
| R14 | **Seed/demo data reaching production** | Embarrassment, bad metrics | Demo tenants flagged `isDemo`, excluded from platform analytics, seeding gated on `NODE_ENV !== 'production'` | Mitigated |
| R15 | **Click/Payme integration surprises** — sandbox access needs a registered merchant | Launch delay | Adapters written against the published protocols behind the common interface; `MockProvider` unblocks all development and demos; only credentials are missing | Accepted |
| R16 | **Single Postgres as the bottleneck** | Scaling wall | Indexed for tenant-leading access, read replicas + PgBouncer as the first lever, analytics moved to rollups; sharding by tenant remains possible because every row already carries `tenantId` | Accepted for MVP |
| R17 | **Cost overrun** for an early-stage startup | Runway | One VPS with Docker Compose runs the whole stack; no Kubernetes, no managed enterprise services until the load justifies them | Accepted |

## Watch list (revisit at 100 tenants)

* Analytics on the OLTP database — move to rollup tables (started) then a read replica.
* Search — Postgres `pg_trgm` today; Meilisearch when global search gets slow.
* Image pipeline — sharp in-process today; a dedicated service when uploads grow.
* Outbox table growth — partition by month and archive processed rows.
