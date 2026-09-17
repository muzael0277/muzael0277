/**
 * The payment provider interface.
 *
 * The rule that makes this work: **a provider never touches the database.** It returns a
 * normalized intent, and one service applies it through a single idempotent state
 * machine. Amount verification, replay protection and order completion are therefore
 * written once — the place where money bugs hide is centralized and tested
 * (docs/adr/0004-provider-adapters.md).
 */

export type PaymentProviderKey = 'cash' | 'click' | 'payme' | 'telegram_stars' | 'mock';

export interface ProviderContext {
  tenantId: string;
  /** Decrypted credentials, resolved from the vault for the duration of this call only. */
  credentials: Record<string, string>;
  config: Record<string, unknown>;
  /** Base URL the provider should send the customer back to. */
  returnUrl?: string;
  language: 'uz' | 'ru' | 'en';
}

export interface PaymentSubject {
  paymentId: string;
  /** Minor units, in the tenant's currency. */
  amount: number;
  currency: string;
  orderId?: string;
  bookingId?: string;
  /** Human-facing reference shown on the provider's checkout page. */
  reference: string;
  description: string;
  customerPhone?: string;
}

export interface CreatePaymentResult {
  /** Where to send the customer, when the provider hosts checkout. */
  checkoutUrl?: string;
  /** Provider-side id, when it is known at creation time. */
  externalId?: string;
  /** Instructions rendered in the Mini App when there is no redirect (cash). */
  instructions?: { uz: string; ru: string; en: string };
  /** True when the payment is already settled — cash on delivery is "pending on us". */
  settledImmediately: boolean;
}

export type NormalizedIntent =
  | { kind: 'mark_paid'; externalId: string; amount: number; paidAt: Date }
  | { kind: 'mark_failed'; externalId?: string; reason: string }
  | { kind: 'mark_cancelled'; externalId?: string; reason: string }
  | { kind: 'mark_refunded'; externalId: string; amount: number }
  | { kind: 'noop'; reason: string };

export interface WebhookRequest {
  /** Exact bytes received. Signature checks must use these, never a reserialized body. */
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  parsedBody: unknown;
  query: Record<string, string | undefined>;
}

export interface WebhookOutcome {
  /** Deduplication key — the provider's own event or transaction id. */
  idempotencyKey: string;
  /** Which payment this concerns; providers echo our id back in their payload. */
  paymentId?: string;
  intent: NormalizedIntent;
  /** The exact body to return. Providers like Payme require a specific JSON-RPC shape. */
  response: unknown;
  /** HTTP status to return; defaults to 200. */
  statusCode?: number;
}

export interface PaymentStatusResult {
  state: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
  externalId?: string;
  paidAmount?: number;
}

export interface RefundResult {
  refundedAmount: number;
  externalRefundId?: string;
}

/**
 * What to answer when a correctly signed callback names a payment we do not have.
 *
 * Every provider has a code for this in its own protocol, and answering with a generic
 * error instead makes the provider retry a callback that can never succeed. The shape
 * is the provider's, so the provider supplies it.
 */
export interface NotFoundResponse {
  response: unknown;
  statusCode?: number;
}

export class PaymentProviderError extends Error {
  constructor(
    readonly provider: PaymentProviderKey,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

export interface PaymentProvider {
  readonly key: PaymentProviderKey;
  readonly capabilities: {
    refund: boolean;
    hold: boolean;
    webhook: boolean;
    /** Provider hosts the checkout page and we redirect the customer there. */
    redirect: boolean;
  };
  /** Credential keys this provider needs, used to validate an Integration on save. */
  readonly requiredCredentials: readonly string[];

  createPayment(ctx: ProviderContext, subject: PaymentSubject): Promise<CreatePaymentResult>;
  getPaymentStatus(ctx: ProviderContext, subject: PaymentSubject): Promise<PaymentStatusResult>;
  cancelPayment(ctx: ProviderContext, subject: PaymentSubject, reason: string): Promise<void>;
  refundPayment(
    ctx: ProviderContext,
    subject: PaymentSubject,
    amount: number,
  ): Promise<RefundResult>;

  /**
   * Verifies authenticity. Throws PaymentProviderError on a bad signature — never
   * returns false, so a caller cannot accidentally ignore the result.
   */
  verifyWebhook(ctx: ProviderContext, request: WebhookRequest): Promise<void>;

  /** Translates a verified webhook into a normalized intent. Performs no writes. */
  handleWebhook(ctx: ProviderContext, request: WebhookRequest): Promise<WebhookOutcome>;

  /**
   * The answer to a verified callback that names a payment we do not have.
   *
   * Optional: a provider without one gets a plain 404. Implement it for any provider
   * that retries on an unrecognized response — otherwise a single stray callback is
   * retried forever.
   */
  notFoundResponse?(request: WebhookRequest): NotFoundResponse;
}
