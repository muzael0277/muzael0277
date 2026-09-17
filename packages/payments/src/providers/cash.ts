import type {
  CreatePaymentResult, PaymentProvider, PaymentStatusResult, ProviderContext,
  PaymentSubject, RefundResult, WebhookOutcome,
} from '../provider';

/**
 * Cash on delivery or at the counter.
 *
 * Still a provider rather than a special case in order code: "how did they pay" is a
 * provider detail, and once cash is an adapter, the order flow has exactly one payment
 * path instead of two.
 */
export class CashProvider implements PaymentProvider {
  readonly key = 'cash' as const;
  readonly capabilities = { refund: true, hold: false, webhook: false, redirect: false };
  readonly requiredCredentials = [] as const;

  async createPayment(_ctx: ProviderContext, _subject: PaymentSubject): Promise<CreatePaymentResult> {
    return {
      settledImmediately: false,
      instructions: {
        uz: 'To‘lovni buyurtmani qabul qilganingizda naqd pulda amalga oshirasiz.',
        ru: 'Оплата наличными при получении заказа.',
        en: 'Pay with cash when you receive your order.',
      },
    };
  }

  async getPaymentStatus(): Promise<PaymentStatusResult> {
    // Cash is settled by a staff member marking the order paid, not by us polling.
    return { state: 'PENDING' };
  }

  async cancelPayment(): Promise<void> {}

  async refundPayment(_ctx: ProviderContext, _subject: PaymentSubject, amount: number): Promise<RefundResult> {
    // Recorded for the books; the money itself is handed back in person.
    return { refundedAmount: amount };
  }

  async verifyWebhook(): Promise<void> {
    throw new Error('Cash payments have no webhook');
  }

  async handleWebhook(): Promise<WebhookOutcome> {
    throw new Error('Cash payments have no webhook');
  }
}
