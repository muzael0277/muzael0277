# Domain Model

Every table below except `User`, `Profile`, `Plan`, `PlanFeature`, `BusinessTemplate`,
`FeatureFlag` and `ProcessedWebhook` carries `tenantId`. That is the isolation boundary
(see `02-tenant-isolation.md`).

## 1. Identity & tenancy

```
User ──1:1── Profile
  │
  └──< TenantMembership >── Tenant ──< TenantModule
                              │
                              ├── TenantSettings (1:1)
                              ├──< Branch
                              ├──< Subscription ──> Plan ──< PlanFeature
                              └──< Integration
```

- `User` is a **platform** identity (email + password). It is not tenant-scoped — one
  person can own a cafe and manage a friend's salon with one login.
- `TenantMembership` carries the `role`. Authorization is always
  `(userId, tenantId) → role → permissions`, never `user.role`.
- `User.platformRole` (`NONE | SUPPORT | ADMIN`) is a separate axis for super admin.
  A platform admin is not automatically a member of any tenant; cross-tenant reads go
  through an explicitly audited system context.

### Money

All monetary columns are **integers in minor units** with a per-currency exponent
(UZS → exponent 0, so `35000` = 35 000 so'm; USD → exponent 2). Never floats.
Aggregates that accumulate over a lifetime (`Customer.totalSpent`, analytics rollups)
are `BigInt` — 2.1 billion so'm is only ~$170k and a real business will exceed it.
See ADR-0006.

### Translated text

Names/descriptions that customers see are `Json` maps: `{"uz": "Osh", "ru": "Плов"}`,
resolved by `resolveI18n(value, lang, fallbackChain)`. Admin-only text stays plain.

## 2. CRM

```
Customer ──< CustomerAddress
    │   ├──< CustomerTagLink >── CustomerTag
    │   ├──< CustomerNote
    │   ├──< CustomerTimelineEntry
    │   ├──< Order / Booking / Payment
    │   ├──1:1 LoyaltyAccount ──< LoyaltyTransaction
    │   └──< Conversation ──< Message
```

`Customer` is created automatically the first time a Telegram user touches a tenant's
bot or Mini App. Unique on `(tenantId, telegramUserId)` and separately on
`(tenantId, phone)` so a walk-in captured by phone and the same person on Telegram
converge on one record.

Denormalized counters (`totalSpent`, `orderCount`, `bookingCount`, `loyaltyBalance`,
`lastActivityAt`) exist for list/segment performance. They are only ever updated inside
the same transaction as the fact that changed them, and `loyaltyBalance` is additionally
reconcilable from its ledger (invariant I5).

`CustomerTimelineEntry` is the unified activity feed — appended by event handlers, never
written directly by UI code. It is the substrate both for the CRM timeline and, later,
for AI context.

**Segments** are stored as a `CustomerSegment` row holding a JSON filter tree
(`{all:[{field,op,value}]}`) compiled to SQL by `SegmentCompiler`. "New customers",
"VIP", "inactive 30 days" are _seeded rows_, not `if` branches — so tenants can create
their own later without a deploy.

## 3. Catalog & services

```
Category (self-referencing, nested)
    └──< Product ──< ProductVariant
                 ├──< ProductImage
                 └──< ProductModifierGroupLink >── ModifierGroup ──< ModifierOption
Service ──< EmployeeService >── Employee
```

`ModifierGroup`/`ModifierOption` (not one flat modifier table) because restaurants need
"choose exactly 1 size" and "choose up to 3 toppings" — that is `minSelect`/`maxSelect`
on the group. Groups are reusable across products.

`ProductVariant` carries `priceModifier` (delta) rather than absolute price, so a
tenant-wide price change does not require touching every variant.

## 4. Commerce

```
Cart ──< CartItem ──< CartItemModifier
Order ──< OrderItem ──< OrderItemModifier
   ├──< OrderStatusHistory
   ├──< Payment ──< PaymentTransaction
   └──> Branch / Customer / CustomerAddress
```

`OrderItem` is a **snapshot**: `nameSnapshot`, `unitPrice`, `variantNameSnapshot`,
modifier names and prices are copied at creation. A price change or a deleted product
must never rewrite history (invariant I6).

`Cart` is server-side and persistent per `(tenantId, customerId)`. The client may send
quantities and selections; it may never send prices. Checkout recomputes everything
through `PricingService` (invariant I2).

Order status is an enum today (`NEW → ACCEPTED → PREPARING → READY → DELIVERING →
COMPLETED | CANCELLED`) but transitions are validated by a `StatusPipeline` resolved
from template config, so a per-tenant custom pipeline is a data change later.

## 5. Booking

```
BookingResource ──> Employee? / Branch
      │              (kind: EMPLOYEE | ROOM | EQUIPMENT | TABLE | VEHICLE | GENERIC)
      ├──< ResourceSchedule     (weekly working hours)
      ├──< ResourceTimeOff      (holidays, sick days, one-off blocks)
      └──< Booking ──< BookingStatusHistory
```

Booking is modelled around **`BookingResource`**, not `Employee`. A barber, a dental
chair, a meeting room and a car lift are all resources with a schedule. `Employee` is
one _kind_ of resource, joined 1:1 when `kind = EMPLOYEE`. This is what makes the same
engine work for salons, clinics, car services and courts. See `09-booking-engine.md`.

## 6. Operations

- `InventoryTransaction` — append-only ledger (`PURCHASE | SALE | RETURN | ADJUSTMENT |
WRITE_OFF | TRANSFER`). `ProductVariant.stockQuantity` is a cached projection;
  it is never written without a ledger row in the same transaction.
- `LoyaltyTransaction` — same pattern (`EARN | SPEND | ADJUSTMENT | EXPIRE | REFUND`).
- `PromoCode` + `PromoUsage` — `PromoCode.rules` is JSON so `BUY_X_GET_Y`, category
  scoping and segment targeting are added without a migration; MVP implements
  `PERCENTAGE` and `FIXED` with `minOrderTotal` / `maxDiscount` / usage caps.

## 7. Platform plumbing

| Entity                                  | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `DomainEvent`                           | Transactional outbox. Written in the same tx as the business change.  |
| `ProcessedWebhook`                      | Idempotency keys for inbound webhooks and Telegram updates.           |
| `IdempotencyKey`                        | Client-supplied keys for `POST /orders`, `POST /bookings`.            |
| `Integration`                           | Generic third-party connection; `config` public, `secretRef` → vault. |
| `Webhook` / `WebhookDelivery`           | Outbound tenant webhooks, signed + retried.                           |
| `NotificationTemplate` / `Notification` | Channel-agnostic messaging with variables.                            |
| `CustomFieldDefinition`                 | Per-tenant, per-entity dynamic fields → entity `customFields` JSONB.  |
| `AuditLog`                              | Append-only record of sensitive actions.                              |
| `FeatureFlag` / `TenantFeatureFlag`     | Global / per-plan / per-tenant rollout.                               |
| `Automation` (Phase 4)                  | trigger → conditions → actions, driven by `DomainEvent`.              |

## 8. Indexing strategy

Every tenant-scoped table leads with `tenantId` in its composite indexes, because every
query is already filtered by it:

```
Customer      (tenantId, lastActivityAt) · unique (tenantId, telegramUserId) · unique (tenantId, phone)
Order         (tenantId, status, createdAt) · (tenantId, customerId) · unique (tenantId, orderNumber)
Booking       (tenantId, resourceId, startsAt) · (tenantId, startsAt) · (tenantId, customerId)
Product       (tenantId, categoryId, isActive) · unique (tenantId, sku)
Payment       (tenantId, status) · unique (provider, externalId)
DomainEvent   (status, availableAt) · (tenantId, occurredAt)
InventoryTx   (tenantId, variantId, createdAt)
AuditLog      (tenantId, createdAt) · (tenantId, actorUserId)
```

The booking overlap query is served by `(tenantId, resourceId, startsAt)` plus an
exclusion-style check in the transaction; see `09-booking-engine.md`.
