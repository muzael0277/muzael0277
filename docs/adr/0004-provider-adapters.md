# ADR-0004 — Provider adapters for every third party

**Status:** Accepted · 2026-09-16

## Decision
Payments, SMS, delivery, storage and AI all sit behind narrow interfaces in `packages/*`.
Domain code depends on the interface. A provider never touches the database; it returns a
normalized intent that one service applies.

## Rationale
* Click and Payme are not a business concept — "the order is paid" is. A provider name
  must never appear in `OrderService`.
* Credentials are per tenant, so provider selection is runtime data, not a compile-time
  import.
* We cannot obtain Click/Payme sandbox credentials before merchant registration.
  `MockProvider` lets the entire checkout flow be built, demoed and tested now
  (risk R15).
* Idempotency, amount verification and the state machine are written once and are
  identical for every provider — the place where money bugs hide is centralised and
  tested.

## Consequences
Each provider's protocol quirks (Payme's JSON-RPC, Click's two-stage prepare/complete)
stay inside its adapter. Adding a provider is a file plus an `Integration` row.
