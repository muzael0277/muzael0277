# ADR-0006 — Money as integer minor units

**Status:** Accepted · 2026-09-16

## Decision

Every monetary value is an integer in the currency's minor unit, alongside an explicit
currency. UZS has exponent **0** (tiyin is obsolete in practice), so `35000` is
35 000 so'm. USD/RUB have exponent 2. Formatting, parsing and arithmetic live in
`@bizbot/shared/money`; a raw `number` is never formatted ad hoc.

Line-level amounts are `Int`. Lifetime accumulators (`Customer.totalSpent`, analytics
rollups) are `BigInt`: 2 147 483 647 so'm is roughly $170 000, which a real business
passes within a year.

## Rationale

Floats cannot represent decimal money. `Decimal` is correct but leaks a library type
through every layer and serialises inconsistently to JSON. Integers are exact, fast,
index well and survive JSON — as long as the exponent is explicit and centralised.

## Consequences

Discount splitting across order lines must allocate remainders deterministically
(largest-remainder), so the sum of lines always equals the order total — covered by
`order-pricing.spec`. `BigInt` needs an explicit JSON serializer, registered globally.
