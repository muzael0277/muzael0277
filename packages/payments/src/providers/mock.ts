import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
  ProviderContext,
  PaymentSubject,
  RefundResult,
  WebhookOutcome,
  WebhookRequest,
} from '../provider';
import { PaymentProviderError } from '../provider';

/**
 * Demo and test provider.
 *
 * Click and Payme sandbox credentials require a registered merchant, which an early-stage
 * product does not have on day one (risk R15). This provider makes the entire checkout
 * flow — creation, redirect, webhook, replay, refund — buildable, demonstrable and
 * testable now, with the same interface the real ones implement. It is refused in
 * production unless a business is explicitly flagged as a demo.
 */
export class MockProvider implements PaymentProvider {
  readonly key = 'mock' as const;
  readonly capabilities = { refund: true, hold: false, webhook: true, redirect: true };
  readonly requiredCredentials = ['secret'] as const;

  async createPayment(ctx: ProviderContext, subject: PaymentSubject): Promise<CreatePaymentResult> {
    const base = (ctx.config.checkoutBaseUrl as string) ?? '/demo-payment';
    return {
      checkoutUrl: `${base}?payment=${subject.paymentId}&amount=${subject.amount}`,
      externalId: `mock_${subject.paymentId}`,
      settledImmediately: false,
    };
  }

  async getPaymentStatus(): Promise<PaymentStatusResult> {
    return { state: 'PENDING' };
  }

  async cancelPayment(): Promise<void> {}

  async refundPayment(
    _ctx: ProviderContext,
    _s: PaymentSubject,
    amount: number,
  ): Promise<RefundResult> {
    return { refundedAmount: amount, externalRefundId: `mock_refund_${Date.now()}` };
  }

  async verifyWebhook(ctx: ProviderContext, request: WebhookRequest): Promise<void> {
    const secret = ctx.credentials.secret;
    if (!secret)
      throw new PaymentProviderError('mock', 'NO_SECRET', 'Mock provider has no secret configured');

    const presented = request.headers['x-mock-signature'];
    if (!presented)
      throw new PaymentProviderError('mock', 'NO_SIGNATURE', 'Missing signature header');

    const expected = createHmac('sha256', secret).update(request.rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError('mock', 'BAD_SIGNATURE', 'Signature mismatch');
    }
  }

  async handleWebhook(_ctx: ProviderContext, request: WebhookRequest): Promise<WebhookOutcome> {
    const body = request.parsedBody as {
      event?: string;
      paymentId?: string;
      externalId?: string;
      amount?: number;
      eventId?: string;
    };

    if (!body?.paymentId || !body.eventId) {
      throw new PaymentProviderError('mock', 'BAD_PAYLOAD', 'paymentId and eventId are required');
    }

    const externalId = body.externalId ?? `mock_${body.paymentId}`;

    switch (body.event) {
      case 'payment.succeeded':
        return {
          idempotencyKey: body.eventId,
          paymentId: body.paymentId,
          intent: { kind: 'mark_paid', externalId, amount: body.amount ?? 0, paidAt: new Date() },
          response: { ok: true },
        };
      case 'payment.failed':
        return {
          idempotencyKey: body.eventId,
          paymentId: body.paymentId,
          intent: { kind: 'mark_failed', externalId, reason: 'Declined by mock provider' },
          response: { ok: true },
        };
      case 'payment.refunded':
        return {
          idempotencyKey: body.eventId,
          paymentId: body.paymentId,
          intent: { kind: 'mark_refunded', externalId, amount: body.amount ?? 0 },
          response: { ok: true },
        };
      default:
        return {
          idempotencyKey: body.eventId,
          paymentId: body.paymentId,
          intent: { kind: 'noop', reason: `Unhandled event: ${body.event}` },
          response: { ok: true },
        };
    }
  }
}
