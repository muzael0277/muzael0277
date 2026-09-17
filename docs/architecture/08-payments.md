# Payments

## 1. Adapter, not special cases

Click and Payme must not be `if` branches inside order code. Every provider implements:

```ts
interface PaymentProvider {
  readonly key: PaymentProviderKey;
  readonly capabilities: { refund: boolean; hold: boolean; webhook: boolean };
  createPayment(ctx, input): Promise<CreatePaymentResult>; // → checkout url / instructions
  getPaymentStatus(ctx, payment): Promise<PaymentStatus>;
  cancelPayment(ctx, payment, reason): Promise<void>;
  refundPayment(ctx, payment, amount): Promise<RefundResult>;
  verifyWebhook(ctx, req): Promise<WebhookVerification>; // signature/auth — throws on bad
  handleWebhook(ctx, req): Promise<WebhookOutcome>; // → normalized intent
}
```

`ctx` carries tenant + decrypted credentials resolved from `Integration.secretRef`.
Shipped: `CashProvider`, `ClickProvider`, `PaymeProvider`, `TelegramStarsProvider`
(declared), `MockProvider` (demo mode and tests).

**A provider never touches the database.** It returns a normalized intent
(`{ kind: 'mark_paid' | 'mark_failed' | 'mark_refunded', externalId, amount }`) and
`PaymentService` applies it through one idempotent state machine. Adding a provider is
therefore a file plus an `Integration` row — no changes to order logic.

## 2. State machine

```
PENDING ──▶ PROCESSING ──▶ PAID ──▶ REFUNDED
   │             │
   └─────────────┴──▶ FAILED / CANCELLED / EXPIRED
```

Transitions are declared in a table and validated. `PAID → PAID` is a **no-op returning
success**, which is what makes replay safe.

## 3. Webhook idempotency (invariant I4)

```
POST /v1/payments/webhook/:provider/:integrationId
  1. resolve integration (system ctx) → tenant + credentials
  2. provider.verifyWebhook()                        ← bad signature ⇒ 401, audit log
  3. ProcessedWebhook.create({ source: provider, key: providerEventId })
        unique violation ⇒ already handled ⇒ return the stored response
  4. within ONE transaction:
        payment.transition(intent)                   ← no-op if already final
        PaymentTransaction.append(raw payload)
        if newly PAID: order.markPaid(), emit payment.succeeded
  5. store + return the provider's expected response shape
```

`payment.succeeded` is what credits loyalty and notifies the customer — and because it is
only emitted on a _real_ transition, a replay cannot double-credit bonuses or complete an
order twice.

Payme's JSON-RPC merchant protocol (`CheckPerformTransaction`, `CreateTransaction`,
`PerformTransaction`, `CancelTransaction`, `CheckTransaction`) and Click's two-stage
`prepare`/`complete` with MD5 signature are both mapped onto this pipeline by their
adapters; their protocol quirks stay inside the adapter.

## 4. Credentials

Stored as `Integration.secretRef` → `SecretVault` (AES-256-GCM, key from
`SECRETS_ENCRYPTION_KEY`, per-record IV, auth tag stored alongside). Decrypted only in the
provider call path. Serializers strip anything secret-shaped, and the I7 tests assert
that no API response ever contains a stored secret.

## 5. Money safety

Every webhook re-checks that the provider's amount equals the stored `Payment.amount`;
a mismatch fails the payment, writes an `AuditLog` and alerts rather than silently
accepting an underpayment.
