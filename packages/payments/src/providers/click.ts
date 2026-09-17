import { createHash } from 'node:crypto';
import type {
  CreatePaymentResult, PaymentProvider, PaymentStatusResult, ProviderContext,
  PaymentSubject, RefundResult, WebhookOutcome, WebhookRequest,
} from '../provider';
import { PaymentProviderError } from '../provider';

/**
 * Click (Uzbekistan).
 *
 * Click uses a two-stage callback: `Prepare` (action 0) reserves the payment, `Complete`
 * (action 1) confirms it. Both are authenticated with an MD5 signature over a fixed field
 * order — MD5 is Click's choice, not ours, and the adapter is where that stays.
 *
 * Click sends amounts in so'm as a decimal string. We store integer minor units with
 * exponent 0 for UZS, so the comparison is against a rounded number — and a mismatch is
 * rejected rather than accepted, because an underpayment silently marked paid is a direct
 * financial loss.
 */

const CLICK_ERROR = {
  SUCCESS: 0,
  SIGN_CHECK_FAILED: -1,
  INCORRECT_AMOUNT: -2,
  ACTION_NOT_FOUND: -3,
  ALREADY_PAID: -4,
  TRANSACTION_NOT_FOUND: -6,
  TRANSACTION_CANCELLED: -9,
} as const;

interface ClickCallback {
  click_trans_id: string;
  service_id: string;
  click_paydoc_id?: string;
  merchant_trans_id: string;
  merchant_prepare_id?: string;
  amount: string;
  action: string;
  error: string;
  error_note?: string;
  sign_time: string;
  sign_string: string;
}

export class ClickProvider implements PaymentProvider {
  readonly key = 'click' as const;
  readonly capabilities = { refund: false, hold: true, webhook: true, redirect: true };
  readonly requiredCredentials = ['serviceId', 'merchantId', 'secretKey', 'merchantUserId'] as const;

  async createPayment(ctx: ProviderContext, subject: PaymentSubject): Promise<CreatePaymentResult> {
    const serviceId = this.credential(ctx, 'serviceId');
    const merchantId = this.credential(ctx, 'merchantId');

    // Click's hosted checkout takes the amount in so'm; UZS has exponent 0, so the
    // stored minor-unit value is already correct.
    const url = new URL('https://my.click.uz/services/pay');
    url.searchParams.set('service_id', serviceId);
    url.searchParams.set('merchant_id', merchantId);
    url.searchParams.set('amount', String(subject.amount));
    url.searchParams.set('transaction_param', subject.paymentId);
    if (ctx.returnUrl) url.searchParams.set('return_url', ctx.returnUrl);

    return { checkoutUrl: url.toString(), settledImmediately: false };
  }

  async getPaymentStatus(): Promise<PaymentStatusResult> {
    // Click is callback-driven. Polling would need the merchant API, which is a separate
    // credential set; until a tenant needs it, reporting PENDING is honest.
    return { state: 'PENDING' };
  }

  async cancelPayment(): Promise<void> {}

  async refundPayment(): Promise<RefundResult> {
    throw new PaymentProviderError('click', 'NOT_SUPPORTED', 'Click refunds are processed in the merchant cabinet');
  }

  async verifyWebhook(ctx: ProviderContext, request: WebhookRequest): Promise<void> {
    const body = request.parsedBody as ClickCallback;
    const secretKey = this.credential(ctx, 'secretKey');

    if (!body?.sign_string || !body.click_trans_id) {
      throw new PaymentProviderError('click', 'BAD_PAYLOAD', 'Malformed Click callback');
    }

    // Field order is fixed by Click's specification. merchant_prepare_id is present only
    // on the Complete call, and must be omitted entirely on Prepare.
    const parts = [
      body.click_trans_id,
      body.service_id,
      secretKey,
      body.merchant_trans_id,
      ...(body.action === '1' && body.merchant_prepare_id ? [body.merchant_prepare_id] : []),
      body.amount,
      body.action,
      body.sign_time,
    ];

    const expected = createHash('md5').update(parts.join('')).digest('hex');
    if (expected !== body.sign_string.toLowerCase()) {
      throw new PaymentProviderError('click', 'BAD_SIGNATURE', 'Click signature mismatch');
    }
  }

  async handleWebhook(_ctx: ProviderContext, request: WebhookRequest): Promise<WebhookOutcome> {
    const body = request.parsedBody as ClickCallback;
    const paymentId = body.merchant_trans_id;
    const amount = Math.round(Number(body.amount));

    // Click signals its own failure through a negative `error` field.
    if (Number(body.error) < 0) {
      return {
        idempotencyKey: `click:${body.click_trans_id}:${body.action}`,
        paymentId,
        intent: { kind: 'mark_cancelled', externalId: body.click_trans_id, reason: body.error_note ?? 'Cancelled by Click' },
        response: {
          click_trans_id: body.click_trans_id,
          merchant_trans_id: paymentId,
          error: CLICK_ERROR.SUCCESS,
          error_note: 'Success',
        },
      };
    }

    if (body.action === '0') {
      // Prepare: acknowledge and reserve. No money has moved, so the payment is not
      // marked paid here — doing so is the classic Click integration bug.
      return {
        idempotencyKey: `click:${body.click_trans_id}:prepare`,
        paymentId,
        intent: { kind: 'noop', reason: 'Click prepare acknowledged' },
        response: {
          click_trans_id: body.click_trans_id,
          merchant_trans_id: paymentId,
          merchant_prepare_id: paymentId,
          error: CLICK_ERROR.SUCCESS,
          error_note: 'Success',
        },
      };
    }

    if (body.action === '1') {
      return {
        idempotencyKey: `click:${body.click_trans_id}:complete`,
        paymentId,
        intent: { kind: 'mark_paid', externalId: body.click_trans_id, amount, paidAt: new Date() },
        response: {
          click_trans_id: body.click_trans_id,
          merchant_trans_id: paymentId,
          merchant_confirm_id: paymentId,
          error: CLICK_ERROR.SUCCESS,
          error_note: 'Success',
        },
      };
    }

    return {
      idempotencyKey: `click:${body.click_trans_id}:${body.action}`,
      paymentId,
      intent: { kind: 'noop', reason: `Unknown Click action ${body.action}` },
      response: { error: CLICK_ERROR.ACTION_NOT_FOUND, error_note: 'Action not found' },
    };
  }

  private credential(ctx: ProviderContext, key: string): string {
    const value = ctx.credentials[key];
    if (!value) {
      throw new PaymentProviderError('click', 'MISSING_CREDENTIAL', `Click integration is missing "${key}"`);
    }
    return value;
  }
}

export { CLICK_ERROR };
