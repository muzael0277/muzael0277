# Modules & Business Templates

## 1. Modules

```ts
enum Module {
  CRM,
  CATALOG,
  SERVICES,
  ORDERS,
  BOOKING,
  PAYMENTS,
  DELIVERY,
  BRANCHES,
  EMPLOYEES,
  INVENTORY,
  LOYALTY,
  PROMOCODES,
  MARKETING,
  MESSAGES,
  ANALYTICS,
  TELEGRAM, // MVP
  POS,
  FINANCE,
  SUPPLIERS,
  AI,
  AUTOMATION, // declared, gated off
}
```

`TenantModule(tenantId, module, enabled, config Json)` — one row per module per tenant.
`config` holds module-specific settings (delivery zones and fees, booking buffer minutes,
loyalty rate) so settings live with the module that owns them rather than in one giant
settings blob.

**Dependencies** are declared, not assumed:

```
ORDERS   → CATALOG or SERVICES, CRM
BOOKING  → SERVICES, CRM
DELIVERY → ORDERS
INVENTORY→ CATALOG
LOYALTY  → CRM
POS      → CATALOG, ORDERS, PAYMENTS
```

`ModuleService.disable()` refuses to strand a dependent module and says which one.
Disabling never deletes data — re-enabling restores the tenant's history.

Effects of enabling/disabling, all driven from one place:
admin navigation · dashboard widgets · Mini App tabs · bot menu buttons · API access
(`ModuleGuard`) · onboarding steps · analytics sections.

## 2. Business templates

A `BusinessTemplate` is a **data row**, not code:

```jsonc
{
  "key": "RESTAURANT",
  "name": { "uz": "Restoran / Kafe", "ru": "Ресторан / Кафе" },
  "modules": ["CRM","CATALOG","ORDERS","PAYMENTS","DELIVERY","BRANCHES","INVENTORY","LOYALTY","MESSAGES","ANALYTICS","TELEGRAM"],
  "moduleConfig": { "ORDERS": { "fulfillment": ["DELIVERY","PICKUP","DINE_IN"] },
                    "LOYALTY": { "type": "CASHBACK", "rate": 5 } },
  "customFields": [],
  "seedContent": { "categories": [...], "modifierGroups": [...] },
  "miniappLayout": { "tabs": ["home","menu","cart","orders","profile"] },
  "orderPipeline": ["NEW","ACCEPTED","PREPARING","READY","DELIVERING","COMPLETED"]
}
```

Shipped: `ONLINE_STORE`, `RESTAURANT`, `BEAUTY`, `SERVICE` (clinic/auto/education/
consulting), `CUSTOM`. A new vertical is a new row — the acceptance test for "is this
architecture right" is that adding _Hotel_ requires no TypeScript.

Applying a template writes `TenantModule` rows, seeds categories/modifier groups and
custom fields, then **detaches**: the tenant may freely toggle modules afterwards.
`Tenant.templateKey` is kept for analytics and defaults, never re-applied silently.

## 3. Smart onboarding (Phase 3)

The owner answers plain business questions — _Do customers book appointments? Do you
deliver? How many branches?_ — and `TemplateRecommender` maps answers to a template plus
module deltas. It is a pure function over an answer map, so it is unit-testable and the
owner never sees the word "module" unless they open advanced settings.
