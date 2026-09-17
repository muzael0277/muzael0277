import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ClickProvider, CLICK_ERROR } from '../providers/click';
import { PaymeProvider, PAYME_ERROR, TIYIN_PER_SOM } from '../providers/payme';
import { CashProvider } from '../providers/cash';
import { getProvider, availableProviders, providerForMethod } from '../registry';
import { PaymentProviderError } from '../provider';
import type { ProviderContext, PaymentSubject, WebhookRequest } from '../provider';

/**
 * Provider adapters, tested at their boundary.
 *
 * These run without a database or network because that is the point of the adapter
 * split (docs/adr/0004-provider-adapters.md): signature checking, amount conversion and
 * intent shaping are pure functions of the request, so they can be pinned exactly.
 *
 * Every case here is a way to lose money: an accepted forged callback, an underpayment
 * marked paid, a "prepare" treated as a payment, or a 100x currency-unit slip.
 */

const SECRET = 'click-secret-key';
const PAYME_KEY = 'payme-merchant-key';

function ctx(credentials: Record<string, string>): ProviderContext {
  return {
    tenantId: 'aa000000-0000-4000-8000-0000000000aa',
    credentials,
    config: {},
    language: 'uz',
  };
}

function request(parsedBody: unknown, headers: Record<string, string> = {}): WebhookRequest {
  return {
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
    headers,
    parsedBody,
    query: {},
  };
}

/** Builds a Click callback signed exactly as Click signs it. */
function clickCallback(overrides: Partial<Record<string, string>> = {}) {
  const body: Record<string, string> = {
    click_trans_id: '900001',
    service_id: '12345',
    merchant_trans_id: 'pay_0001',
    amount: '69000',
    action: '0',
    error: '0',
    sign_time: '2026-09-17 10:00:00',
    ...overrides,
  };
  const parts = [
    body.click_trans_id,
    body.service_id,
    SECRET,
    body.merchant_trans_id,
    ...(body.action === '1' && body.merchant_prepare_id ? [body.merchant_prepare_id] : []),
    body.amount,
    body.action,
    body.sign_time,
  ];
  body.sign_string = createHash('md5').update(parts.join('')).digest('hex');
  return body;
}

describe('Click', () => {
  const click = new ClickProvider();
  const clickCtx = ctx({
    serviceId: '12345',
    merchantId: '54321',
    secretKey: SECRET,
    merchantUserId: '1',
  });

  it('accepts a correctly signed callback', async () => {
    await expect(click.verifyWebhook(clickCtx, request(clickCallback()))).resolves.toBeUndefined();
  });

  it('rejects a callback whose amount was edited after signing', async () => {
    const body = clickCallback();
    body.amount = '1';
    await expect(click.verifyWebhook(clickCtx, request(body))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const other = ctx({ ...clickCtx.credentials, secretKey: 'not-the-secret' });
    await expect(click.verifyWebhook(other, request(clickCallback()))).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });

  it('accepts an uppercase sign_string', async () => {
    // Click has been observed sending the hex digest in either case; rejecting one of
    // them would fail real payments.
    const body = clickCallback();
    body.sign_string = body.sign_string.toUpperCase();
    await expect(click.verifyWebhook(clickCtx, request(body))).resolves.toBeUndefined();
  });

  it('refuses a callback with no signature at all', async () => {
    const body = clickCallback();
    delete body.sign_string;
    await expect(click.verifyWebhook(clickCtx, request(body))).rejects.toMatchObject({
      code: 'BAD_PAYLOAD',
    });
  });

  it('fails loudly when the secret key is not configured', async () => {
    const bare = ctx({ serviceId: '1', merchantId: '2', merchantUserId: '3' });
    await expect(click.verifyWebhook(bare, request(clickCallback()))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });

  it('signs Complete with merchant_prepare_id included', async () => {
    const body = clickCallback({ action: '1', merchant_prepare_id: 'pay_0001' });
    await expect(click.verifyWebhook(clickCtx, request(body))).resolves.toBeUndefined();
  });

  it('does not mark a payment paid on Prepare', async () => {
    // The classic Click integration bug: action 0 reserves, it does not settle.
    const outcome = await click.handleWebhook(clickCtx, request(clickCallback({ action: '0' })));
    expect(outcome.intent.kind).toBe('noop');
    expect((outcome.response as { error: number }).error).toBe(CLICK_ERROR.SUCCESS);
  });

  it('marks the payment paid on Complete, with the amount Click reported', async () => {
    const outcome = await click.handleWebhook(
      clickCtx,
      request(clickCallback({ action: '1', merchant_prepare_id: 'pay_0001' })),
    );
    expect(outcome.intent).toMatchObject({ kind: 'mark_paid', amount: 69000 });
    expect(outcome.paymentId).toBe('pay_0001');
  });

  it('gives Prepare and Complete different idempotency keys', async () => {
    // One shared key would make the Complete look like a replay of the Prepare and drop
    // the actual payment.
    const prepare = await click.handleWebhook(clickCtx, request(clickCallback({ action: '0' })));
    const complete = await click.handleWebhook(
      clickCtx,
      request(clickCallback({ action: '1', merchant_prepare_id: 'pay_0001' })),
    );
    expect(prepare.idempotencyKey).not.toBe(complete.idempotencyKey);
  });

  it('derives the idempotency key from Click state only, so a replay repeats it', async () => {
    const a = await click.handleWebhook(clickCtx, request(clickCallback({ action: '1' })));
    const b = await click.handleWebhook(clickCtx, request(clickCallback({ action: '1' })));
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('cancels when Click reports its own error', async () => {
    const outcome = await click.handleWebhook(
      clickCtx,
      request(clickCallback({ action: '1', error: '-5', error_note: 'User cancelled' })),
    );
    expect(outcome.intent).toMatchObject({ kind: 'mark_cancelled' });
  });

  it('puts the amount in the checkout URL unchanged — UZS has no minor unit', async () => {
    const subject: PaymentSubject = {
      paymentId: 'pay_0001',
      amount: 69000,
      currency: 'UZS',
      reference: 'A-1001',
      description: 'Pepperoni Pizza',
    };
    const { checkoutUrl } = await click.createPayment(clickCtx, subject);
    expect(new URL(checkoutUrl!).searchParams.get('amount')).toBe('69000');
  });
});

describe('Payme', () => {
  const payme = new PaymeProvider();
  const paymeCtx = ctx({ merchantId: 'm1', key: PAYME_KEY });
  const basic = (password: string) =>
    `Basic ${Buffer.from(`Paycom:${password}`, 'utf8').toString('base64')}`;

  it('accepts the configured merchant key', async () => {
    await expect(
      payme.verifyWebhook(paymeCtx, request({}, { authorization: basic(PAYME_KEY) })),
    ).resolves.toBeUndefined();
  });

  it('rejects a wrong merchant key', async () => {
    await expect(
      payme.verifyWebhook(paymeCtx, request({}, { authorization: basic('wrong-key') })),
    ).rejects.toMatchObject({ code: 'BAD_AUTH' });
  });

  it('rejects a key that is merely a prefix of the real one', async () => {
    await expect(
      payme.verifyWebhook(paymeCtx, request({}, { authorization: basic(PAYME_KEY.slice(0, 5)) })),
    ).rejects.toMatchObject({ code: 'BAD_AUTH' });
  });

  it('rejects a missing Authorization header', async () => {
    await expect(payme.verifyWebhook(paymeCtx, request({}))).rejects.toMatchObject({
      code: 'NO_AUTH',
    });
  });

  it('converts tiyin to so‘m on PerformTransaction', async () => {
    // Payme sends 6 900 000 tiyin for a 69 000 so'm pizza. Storing that number as-is
    // would mark the payment paid for a hundred times the price.
    const outcome = await payme.handleWebhook(
      paymeCtx,
      request({
        method: 'PerformTransaction',
        id: 7,
        params: { id: 'tx_1', amount: 69000 * TIYIN_PER_SOM, account: { payment_id: 'pay_0001' } },
      }),
    );
    expect(outcome.intent).toMatchObject({ kind: 'mark_paid', amount: 69000, externalId: 'tx_1' });
    expect(outcome.paymentId).toBe('pay_0001');
  });

  it('converts so‘m to tiyin in the checkout URL', async () => {
    const { checkoutUrl } = await payme.createPayment(paymeCtx, {
      paymentId: 'pay_0001',
      amount: 69000,
      currency: 'UZS',
      reference: 'A-1001',
      description: 'Pepperoni Pizza',
    });
    const params = Buffer.from(checkoutUrl!.split('/').pop()!, 'base64').toString('utf8');
    expect(params).toContain(`a=${69000 * TIYIN_PER_SOM}`);
  });

  it('does not settle on CreateTransaction', async () => {
    const outcome = await payme.handleWebhook(
      paymeCtx,
      request({ method: 'CreateTransaction', id: 1, params: { id: 'tx_1', time: 1 } }),
    );
    expect(outcome.intent.kind).toBe('noop');
  });

  it('keys Perform and Cancel of one transaction separately', async () => {
    const perform = await payme.handleWebhook(
      paymeCtx,
      request({ method: 'PerformTransaction', id: 1, params: { id: 'tx_1', amount: 100 } }),
    );
    const cancel = await payme.handleWebhook(
      paymeCtx,
      request({ method: 'CancelTransaction', id: 2, params: { id: 'tx_1', reason: 5 } }),
    );
    expect(perform.idempotencyKey).not.toBe(cancel.idempotencyKey);
    expect(cancel.intent.kind).toBe('mark_cancelled');
  });

  it('answers an unknown method with Payme’s own error code', async () => {
    const outcome = await payme.handleWebhook(
      paymeCtx,
      request({ method: 'NotAMethod', id: 3, params: {} }),
    );
    expect(outcome.response).toMatchObject({
      error: { code: PAYME_ERROR.METHOD_NOT_FOUND },
      id: 3,
    });
  });

  it('echoes the JSON-RPC id back, so Payme can match the reply', async () => {
    const outcome = await payme.handleWebhook(
      paymeCtx,
      request({ method: 'CheckPerformTransaction', id: 42, params: { amount: 1 } }),
    );
    expect((outcome.response as { id: number }).id).toBe(42);
  });
});

describe('Cash', () => {
  it('settles immediately and sends no one to a checkout page', async () => {
    const result = await new CashProvider().createPayment(ctx({}), {
      paymentId: 'pay_0001',
      amount: 35000,
      currency: 'UZS',
      reference: 'A-1002',
      description: 'Osh',
    });
    expect(result.checkoutUrl).toBeUndefined();
    expect(result.instructions?.uz).toBeTruthy();
  });
});

describe('registry', () => {
  it('resolves each implemented provider', () => {
    for (const key of availableProviders()) {
      expect(getProvider(key).key).toBe(key);
    }
  });

  it('refuses a declared-but-unimplemented provider instead of falling back', () => {
    // A silent fallback would charge through a different provider than the customer chose.
    expect(availableProviders()).not.toContain('telegram_stars');
    expect(() => getProvider('telegram_stars')).toThrow(/not available/);
  });

  it('maps stored payment methods to providers', () => {
    expect(providerForMethod('CASH')).toBe('cash');
    expect(providerForMethod('CARD_TERMINAL')).toBe('cash');
    expect(providerForMethod('CLICK')).toBe('click');
    expect(providerForMethod('PAYME')).toBe('payme');
  });
});
