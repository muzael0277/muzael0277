# Payment integration

Uzbekistan's two dominant online payment providers are **Click** and **Payme**, and
most orders are still **cash on delivery**. All three, plus a mock provider for
development, are implemented behind one interface.

## The rule that makes this safe

**A provider never touches the database.**

An adapter receives a request, verifies its authenticity, and returns a _normalized
intent_ — `mark_paid`, `mark_failed`, `mark_cancelled`, `mark_refunded` or `noop` —
along with the exact body the provider expects back. One service applies that intent
through a single idempotent state machine.

Amount verification, replay protection and order completion are therefore written
once, in one place, and tested once. Adding a provider cannot introduce a new way to
double-credit a customer, because the code that credits customers is not part of the
provider. See [ADR-0004](../adr/0004-provider-adapters.md).

## Connecting a provider

Credentials are per tenant, entered in the admin dashboard under **Settings →
Payments**, and stored encrypted with AES-256-GCM. They are never returned to any
client — invariant I7, with a test that asserts the configured secret appears in no
API response.

| Provider | Required credentials                                     | Get them from                    |
| -------- | -------------------------------------------------------- | -------------------------------- |
| Click    | `serviceId`, `merchantId`, `secretKey`, `merchantUserId` | Click merchant cabinet           |
| Payme    | `merchantId`, `key`                                      | Payme merchant cabinet           |
| Cash     | none                                                     | —                                |
| Mock     | none                                                     | development and the demo tenants |

The integration service validates that every credential a provider declares is present
before saving. A half-configured provider fails at save time, not at the customer's
checkout.

## Webhook URLs

Give the provider:

```
https://<your-api-host>/v1/payments/webhook/click/<integrationId>
https://<your-api-host>/v1/payments/webhook/payme/<integrationId>
```

The `integrationId` identifies which tenant's credentials to verify against, so one
deployment serves every tenant's callbacks without a shared secret.

Signature verification uses the **raw request bytes**, preserved by the body parser.
An HMAC over a reserialized body does not match, because JSON key order is not stable.

## Click

Click uses a two-stage callback authenticated by an MD5 signature over a fixed field
order (MD5 is Click's choice, not ours; it stays inside the adapter).

| Action | Meaning                | What it does here                      |
| ------ | ---------------------- | -------------------------------------- |
| `0`    | **Prepare** — reserve  | Acknowledged. Nothing is marked paid   |
| `1`    | **Complete** — confirm | `mark_paid` with the amount Click sent |

Treating Prepare as payment is the classic Click integration bug: money has not moved
yet, and an order shipped on a Prepare that never completes is a straight loss. There
is a test named for exactly this.

Prepare and Complete get different idempotency keys — one shared key would make the
Complete look like a replay of the Prepare and drop the actual payment.

Click sends amounts as a decimal string in so'm. UZS has exponent 0, so the stored
minor-unit value is the same number. A mismatch is **rejected**, not accepted: an
underpayment silently marked paid is a direct financial loss.

Refunds are not supported through the API; they are processed in the merchant cabinet,
and the adapter says so rather than pretending.

## Payme

Payme speaks JSON-RPC over a single endpoint, authenticated with HTTP Basic where the
password is the merchant key, compared in constant time.

| Method                    | Intent                                   |
| ------------------------- | ---------------------------------------- |
| `CheckPerformTransaction` | `noop` — may this order be paid?         |
| `CreateTransaction`       | `noop` — transaction opened, not settled |
| `PerformTransaction`      | `mark_paid`                              |
| `CancelTransaction`       | `mark_cancelled`                         |
| `CheckTransaction`        | `noop` — status query                    |

**Payme amounts are in tiyin — 1/100 of a so'm.** We store UZS with exponent 0, so
every amount crossing this boundary is converted. Getting it wrong by 100× is the most
expensive mistake available in this adapter, and it is tested in both directions.

Payme's error codes are part of its contract: returning the wrong one makes Payme
either retry forever or cancel a good transaction. They are constants in the adapter,
not improvised at the call site.

## Replay protection — invariant I4

Providers retry. Networks duplicate. An attacker may simply resend a captured callback.

Each outcome carries an `idempotencyKey` derived from the provider's own transaction
identity — never from a timestamp or a random value. Applying it writes a
`ProcessedWebhook` row **and** the payment change **in the same transaction**. A
duplicate key violates the unique constraint and the whole thing rolls back.

The ordering matters. Writing the dedup row first and applying the intent afterwards
means a mid-processing failure permanently marks the event handled — leaving a charged
customer with a `PENDING` payment and no way for the retry to help. That bug existed
here and is now an explicit test.

The verified test: five deliveries — one forged, one genuine, three replays, one with
a tampered amount — produce exactly one `PAID` payment, one loyalty accrual, and one
order completion.

## Cash

Cash is a real provider, not a gap. It settles at handover, returns instructions
instead of a checkout URL, and is confirmed by staff through
`POST /v1/t/:tenantId/payments/order/:orderId/cash`. Most orders in this market take
this path.

## Development without credentials

The mock provider settles immediately and needs nothing. Demo tenants use it, so the
entire checkout flow — cart, pricing, payment, loyalty accrual, order completion —
works on a laptop with no merchant account.

This is the pattern to follow for any integration whose credentials you do not have:
build the adapter, the configuration page and a mock, and keep moving. Missing
credentials for one service must never block the rest of the system.

## Adding a provider

1. Implement `PaymentProvider` in `packages/payments/src/providers/`.
2. Declare `requiredCredentials` — the integration service enforces them.
3. Register it in `registry.ts` and map the `PaymentMethod` in `providerForMethod`.
4. Write the adapter tests: a valid signature, a tampered one, the amount conversion,
   and the idempotency key for each callback type.

No change to order, cart or checkout code is needed, and none should be necessary.
A provider declared but not yet implemented throws on lookup rather than silently
falling back to another one — charging a customer through a provider they did not
choose is worse than an error.

Design rationale: `docs/architecture/08-payments.md`.
