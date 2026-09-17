import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { tenantContext, type PrismaClient } from '@bizbot/database';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { CatalogService } from '../modules/catalog/catalog.service';
import { CartService } from '../modules/cart/cart.service';
import { OrdersService } from '../modules/orders/orders.service';
import { BookingsService } from '../modules/bookings/bookings.service';
import { LoyaltyService } from '../modules/loyalty/loyalty.service';
import { ServicesService } from '../modules/catalog/services.service';
import { BranchesService } from '../modules/branches/branches.service';
import { TenantsService } from '../modules/tenants/tenants.service';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { PaymentsService } from '../modules/payments/payments.service';

/**
 * The system invariants, exercised through the real services against a real database.
 *
 * These are the behaviours that must never regress: the ones where a bug costs money,
 * leaks another business's data, or double-books a customer. Unit tests cover the pure
 * rules; this suite covers them wired together, because that is where they actually
 * broke during development.
 */

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let prisma: PrismaService;
let raw: PrismaClient;
let catalog: CatalogService;
let cart: CartService;
let orders: OrdersService;
let bookings: BookingsService;
let loyalty: LoyaltyService;
let services: ServicesService;
let branches: BranchesService;
let tenants: TenantsService;
let integrations: IntegrationsService;
let payments: PaymentsService;

const TENANT_A = 'aa000000-0000-4000-8000-0000000000aa';
const TENANT_B = 'bb000000-0000-4000-8000-0000000000bb';
const USER_A = 'a1000000-0000-4000-8000-0000000000a1';

const asA = <T>(fn: () => Promise<T>) => tenantContext.run({ tenantId: TENANT_A }, fn);
const asB = <T>(fn: () => Promise<T>) => tenantContext.run({ tenantId: TENANT_B }, fn);

let productA: string;
let customerA: string;
let customerB: string;
let serviceA: string;
let resourceA: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef;
  await moduleRef.init();

  prisma = moduleRef.get(PrismaService);
  raw = prisma.raw;
  catalog = moduleRef.get(CatalogService);
  cart = moduleRef.get(CartService);
  orders = moduleRef.get(OrdersService);
  bookings = moduleRef.get(BookingsService);
  loyalty = moduleRef.get(LoyaltyService);
  services = moduleRef.get(ServicesService);
  branches = moduleRef.get(BranchesService);
  tenants = moduleRef.get(TenantsService);
  integrations = moduleRef.get(IntegrationsService);
  payments = moduleRef.get(PaymentsService);

  // Tenants own audit rows, which are append-only, so removal goes through the
  // deliberate purge path rather than a bare deleteMany.
  await purgeTenants();
  await raw.user.deleteMany({ where: { id: USER_A } });

  for (const [id, slug] of [
    [TENANT_A, 'inv-a'],
    [TENANT_B, 'inv-b'],
  ] as const) {
    await raw.tenant.create({
      data: {
        id,
        slug,
        name: slug,
        templateKey: 'RESTAURANT',
        status: 'ACTIVE',
        currency: 'UZS',
        settings: {
          create: {
            workingHours: Object.fromEntries(
              [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '09:00', end: '21:00' }]]),
            ),
            deliverySettings: {
              enabled: true,
              flatFee: 15000,
              freeAbove: 200000,
              minOrderTotal: 0,
            },
            loyaltySettings: {
              enabled: true,
              type: 'CASHBACK',
              rate: 10,
              minOrderTotal: 0,
              maxRedeemPercent: 50,
            },
            bookingSettings: {
              slotStepMinutes: 30,
              minLeadTimeMinutes: 0,
              maxAdvanceDays: 60,
              autoConfirm: true,
              cancellationDeadlineMinutes: 60,
              reminderOffsetsMinutes: [],
            },
          },
        },
        modules: {
          create: [
            'CRM',
            'CATALOG',
            'SERVICES',
            'ORDERS',
            'BOOKING',
            'LOYALTY',
            'PAYMENTS',
            'ANALYTICS',
            'TELEGRAM',
            'EMPLOYEES',
          ].map((module) => ({ module, enabled: true })),
        },
      },
    });
  }

  await raw.user.create({
    data: {
      id: USER_A,
      email: 'inv-a@test.local',
      passwordHash: 'x',
      memberships: { create: { tenantId: TENANT_A, role: 'OWNER' } },
    },
  });

  productA = (
    await asA(() =>
      catalog.createProduct(USER_A, {
        name: { uz: 'Test osh' },
        price: 50_000,
        isActive: true,
      }),
    )
  ).id;

  customerA = (
    await raw.customer.create({
      data: {
        tenantId: TENANT_A,
        firstName: 'Aziz',
        loyaltyAccount: { create: { tenantId: TENANT_A } },
      },
    })
  ).id;
  customerB = (
    await raw.customer.create({
      data: {
        tenantId: TENANT_B,
        firstName: 'Rival',
        loyaltyAccount: { create: { tenantId: TENANT_B } },
      },
    })
  ).id;

  serviceA = (
    await asA(() =>
      services.create(USER_A, {
        name: { uz: 'Soch olish' },
        price: 100_000,
        durationMinutes: 60,
        isActive: true,
      }),
    )
  ).id;

  const employee = await asA(() =>
    branches.createEmployee(USER_A, {
      firstName: 'Jamshid',
      serviceIds: [serviceA],
      schedule: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '21:00' })),
    }),
  );
  resourceA = employee.resource!.id;
}, 60_000);

afterAll(async () => {
  await purgeTenants();
  await raw.user.deleteMany({ where: { id: USER_A } });
  await app.close();
});

async function purgeTenants() {
  for (const id of [TENANT_A, TENANT_B]) {
    const exists = await raw.tenant.findUnique({ where: { id }, select: { id: true } });
    if (exists) await tenants.purge(id, null, 'test teardown');
  }
}

// ── I1 ────────────────────────────────────────────────────────────────────────

describe('I1 — tenant isolation across services', () => {
  it('does not surface another tenant products through the catalog service', async () => {
    const seen = await asB(() => catalog.listProducts({}));
    expect(seen.data.map((p) => p.id)).not.toContain(productA);
  });

  it('refuses to add another tenant product to a cart', async () => {
    await expect(
      asB(() =>
        cart.addItem(customerB, { productId: productA, quantity: 1, modifierOptionIds: [] }),
      ),
    ).rejects.toThrow();
  });

  it('refuses to adjust another tenant customer loyalty', async () => {
    // Raw SQL bypasses the Prisma guard, so this path needs its own tenant predicate —
    // without it, one business could alter another's bonuses.
    await expect(asB(() => loyalty.adjust(USER_A, customerA, 1000, 'attempt'))).rejects.toThrow();

    const account = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });
    expect(account.balance).toBe(0);
  });

  it('refuses to book another tenant resource', async () => {
    await expect(
      asB(() =>
        bookings.create(
          {
            serviceId: serviceA,
            resourceId: resourceA,
            startsAt: nextSlot(),
            customerId: customerB,
          },
          { userId: USER_A },
        ),
      ),
    ).rejects.toThrow();
  });
});

// ── I2 ────────────────────────────────────────────────────────────────────────

describe('I2 — the server prices every order', () => {
  it('ignores prices supplied by the client', async () => {
    const order = await asA(() =>
      orders.createByStaff(USER_A, {
        customerId: customerA,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'CASH',
        items: [
          // Every money field here is a lie the client is telling.
          {
            productId: productA,
            quantity: 2,
            modifierOptionIds: [],
            price: 1,
            unitPrice: 1,
            total: 2,
          } as never,
        ],
      }),
    );

    expect(order.subtotal).toBe(100_000);
    expect(order.total).toBe(100_000);
    expect(order.items[0]!.unitPrice).toBe(50_000);
  });

  it('keeps a snapshot so a later price change cannot rewrite history', async () => {
    const order = await asA(() =>
      orders.createByStaff(USER_A, {
        customerId: customerA,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'CASH',
        items: [{ productId: productA, quantity: 1, modifierOptionIds: [] }],
      }),
    );

    await asA(() => catalog.updateProduct(USER_A, productA, { price: 999_000 }));

    const reloaded = await asA(() => orders.detail(order.id));
    expect(reloaded.items[0]!.unitPrice).toBe(50_000);
    expect(reloaded.total).toBe(50_000);

    await asA(() => catalog.updateProduct(USER_A, productA, { price: 50_000 }));
  });

  it('keeps line totals reconciled with the order total', async () => {
    const order = await asA(() =>
      orders.createByStaff(USER_A, {
        customerId: customerA,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'CASH',
        items: [
          { productId: productA, quantity: 3, modifierOptionIds: [] },
          { productId: productA, quantity: 1, modifierOptionIds: [] },
        ],
      }),
    );
    const lineSum = order.items.reduce((sum, i) => sum + i.total, 0);
    expect(lineSum).toBe(order.subtotal - order.discountTotal);
  });
});

// ── I3 ────────────────────────────────────────────────────────────────────────

describe('I3 — a resource cannot be double-booked', () => {
  it('lets exactly one of several concurrent requests win', async () => {
    const startsAt = nextSlot(3);

    const attempts = Array.from({ length: 6 }, () =>
      asA(() =>
        bookings.create(
          { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
          { userId: USER_A },
        ),
      ).then(
        (booking) => ({ ok: true as const, booking }),
        (error: Error) => ({ ok: false as const, error }),
      ),
    );

    const results = await Promise.all(attempts);
    const created = results.filter((r) => r.ok);
    expect(created).toHaveLength(1);

    const stored = await raw.booking.count({
      where: {
        resourceId: resourceA,
        startsAt: new Date(startsAt),
        status: { notIn: ['CANCELLED'] },
      },
    });
    expect(stored).toBe(1);
  }, 30_000);

  it('rejects an overlapping booking even when the start times differ', async () => {
    const base = nextSlot(5);
    await asA(() =>
      bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt: base, customerId: customerA },
        { userId: USER_A },
      ),
    );

    // 30 minutes into a 60-minute appointment.
    const overlapping = new Date(new Date(base).getTime() + 30 * 60_000).toISOString();
    await expect(
      asA(() =>
        bookings.create(
          {
            serviceId: serviceA,
            resourceId: resourceA,
            startsAt: overlapping,
            customerId: customerA,
          },
          { userId: USER_A },
        ),
      ),
    ).rejects.toMatchObject({ code: 'BOOKING_SLOT_TAKEN' });
  }, 20_000);

  it('frees the slot again when the booking is cancelled', async () => {
    const startsAt = nextSlot(7);
    const booking = await asA(() =>
      bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
        { userId: USER_A },
      ),
    );

    await asA(() => bookings.updateStatus(booking.id, 'CANCELLED', { userId: USER_A }));

    const replacement = await asA(() =>
      bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
        { userId: USER_A },
      ),
    );
    expect(replacement.id).not.toBe(booking.id);
  }, 20_000);
});

// ── I4 ────────────────────────────────────────────────────────────────────────

describe('I4 — a payment webhook replay changes nothing', () => {
  const CLICK_SECRET = 'click-secret-for-invariant-tests';
  // Click transaction ids are globally unique in production, and the idempotency key
  // is derived from them. Reusing a fixed id across runs against a persistent database
  // would make the second run's callback look like a replay of the first run's.
  const TX = String(Date.now()).slice(-9);
  let integrationId: string;
  let orderId: string;
  let paymentId: string;
  let orderTotal: number;

  /** Signs a Click callback exactly as Click signs it. */
  const sign = (body: Record<string, string>) => {
    const parts = [
      body.click_trans_id,
      body.service_id,
      CLICK_SECRET,
      body.merchant_trans_id,
      ...(body.action === '1' && body.merchant_prepare_id ? [body.merchant_prepare_id] : []),
      body.amount,
      body.action,
      body.sign_time,
    ];
    return { ...body, sign_string: createHash('md5').update(parts.join('')).digest('hex') };
  };

  const deliver = (body: Record<string, string>) =>
    payments.handleWebhook('click', integrationId, {
      rawBody: Buffer.from(JSON.stringify(body)),
      headers: {},
      parsedBody: body,
      query: {},
    });

  beforeAll(async () => {
    await raw.processedWebhook.deleteMany({ where: { tenantId: TENANT_A } });

    const connected = await asA(() =>
      integrations.upsert(USER_A, {
        type: 'PAYMENT',
        provider: 'click',
        secrets: {
          serviceId: '12345',
          merchantId: '54321',
          secretKey: CLICK_SECRET,
          merchantUserId: '1',
        },
        isEnabled: true,
      }),
    );
    integrationId = connected.id;

    const order = await asA(() =>
      orders.createByStaff(USER_A, {
        customerId: customerA,
        fulfillmentType: 'PICKUP',
        paymentMethod: 'CLICK',
        items: [{ productId: productA, quantity: 2, modifierOptionIds: [] }],
      }),
    );
    orderId = order.id;
    orderTotal = order.total;

    const payment = await asA(() => payments.createForOrder(orderId, 'CLICK'));
    paymentId = payment.id;
  });

  const callback = (overrides: Record<string, string> = {}) =>
    sign({
      click_trans_id: `${TX}1`,
      service_id: '12345',
      merchant_trans_id: paymentId,
      amount: String(orderTotal),
      action: '1',
      merchant_prepare_id: paymentId,
      error: '0',
      sign_time: '2026-09-17 10:00:00',
      ...overrides,
    });

  it('rejects a forged callback before it touches anything', async () => {
    const forged = { ...callback(), sign_string: 'f'.repeat(32) };
    const response = await deliver(forged);

    expect(response.status).toBe(401);
    const payment = await raw.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.state).not.toBe('PAID');
  });

  it('ignores a Prepare — no money has moved yet', async () => {
    await deliver(callback({ click_trans_id: `${TX}2`, action: '0' }));

    const payment = await raw.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.state).not.toBe('PAID');
  });

  it('settles exactly once across four identical deliveries', async () => {
    // Telegram-style retries, a provider replay, and a deliberate resend all look the
    // same from here, and all must add up to one payment.
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await deliver(callback()));

    for (const response of responses) expect(response.status).toBe(200);

    const payment = await raw.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.state).toBe('PAID');

    const order = await raw.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PAID');

    // One dedup row, one accrual, one paid payment on the order.
    const handled = await raw.processedWebhook.count({
      where: { tenantId: TENANT_A, source: 'click' },
    });
    expect(handled).toBe(2); // the prepare and the complete, each once

    const paidPayments = await raw.payment.count({
      where: { tenantId: TENANT_A, orderId, state: 'PAID' },
    });
    expect(paidPayments).toBe(1);

    const accruals = await raw.loyaltyTransaction.count({ where: { orderId, type: 'EARN' } });
    expect(accruals).toBeLessThanOrEqual(1);
  }, 20_000);

  it('does not credit a replay that claims a different amount', async () => {
    const before = await raw.payment.findUniqueOrThrow({ where: { id: paymentId } });

    // Re-signed for the new amount, so the signature is valid — only the money is wrong.
    await deliver(callback({ click_trans_id: `${TX}3`, amount: String(orderTotal * 10) }));

    const after = await raw.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.amount).toBe(before.amount);
    expect(after.amount).toBe(orderTotal);
  });

  it('rejects a callback whose payload was edited after signing', async () => {
    // Rewriting merchant_trans_id to point at someone else\u2019s payment invalidates
    // the signature, and the signature is checked before anything is looked up.
    const tampered = { ...callback(), merchant_trans_id: 'another-tenants-payment' };
    const response = await deliver(tampered);

    expect(response.status).toBe(401);
  });

  it('creates nothing for a correctly signed callback naming an unknown payment', async () => {
    // Correctly signed this time \u2014 the signature proves the sender, not the target.
    const response = await deliver(
      sign({
        click_trans_id: `${TX}4`,
        service_id: '12345',
        merchant_trans_id: 'no-such-payment',
        amount: String(orderTotal),
        action: '1',
        merchant_prepare_id: 'no-such-payment',
        error: '0',
        sign_time: '2026-09-17 10:00:00',
      }),
    );

    expect([200, 404, 500]).toContain(response.status);

    const stillOne = await raw.payment.count({ where: { tenantId: TENANT_A, orderId } });
    expect(stillOne).toBe(1);
    const stray = await raw.payment.count({ where: { id: 'no-such-payment' } });
    expect(stray).toBe(0);
  });
});

// ── I5 ────────────────────────────────────────────────────────────────────────

describe('I5 — a loyalty balance always equals its ledger', () => {
  it('moves the balance and the ledger together', async () => {
    await asA(() => loyalty.adjust(USER_A, customerA, 5_000, 'goodwill'));
    await asA(() => loyalty.adjust(USER_A, customerA, 2_500, 'goodwill again'));
    await asA(() => loyalty.adjust(USER_A, customerA, -1_500, 'correction'));

    const account = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });
    const ledger = await raw.loyaltyTransaction.aggregate({
      where: { accountId: account.id },
      _sum: { amount: true },
    });

    expect(account.balance).toBe(ledger._sum.amount);
    const customer = await raw.customer.findFirstOrThrow({ where: { id: customerA } });
    expect(customer.loyaltyBalance).toBe(account.balance);
  });

  it('refuses to spend more than the balance, leaving it untouched', async () => {
    const before = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });

    await expect(
      asA(() => loyalty.adjust(USER_A, customerA, -(before.balance + 1), 'overdraw')),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_LOYALTY_BALANCE' });

    const after = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });
    expect(after.balance).toBe(before.balance);
  });

  it('holds under concurrent adjustments, which is what the row lock is for', async () => {
    const before = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        asA(() => loyalty.adjust(USER_A, customerA, 1_000, `concurrent ${i}`)),
      ),
    );

    const after = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });
    const ledger = await raw.loyaltyTransaction.aggregate({
      where: { accountId: after.id },
      _sum: { amount: true },
    });

    // Without the FOR UPDATE lock these would read the same balance and lose increments.
    expect(after.balance).toBe(before.balance + 5_000);
    expect(after.balance).toBe(ledger._sum.amount);
  }, 20_000);
});

// ── I7 ────────────────────────────────────────────────────────────────────────

describe('I7 — a stored credential never comes back out', () => {
  // A plausible-looking Payme merchant key. If this string appears anywhere in a
  // response, the vault has leaked and every tenant's payment credentials are exposed.
  const MERCHANT_KEY = 'zR7qN4vK2mX9tB6wL1pH8sJ3dF5gC0aY';
  const MERCHANT_ID = '64f0e1c2b3a4d5e6f7089a1b';

  beforeAll(async () => {
    await asA(() =>
      integrations.upsert(USER_A, {
        type: 'PAYMENT',
        provider: 'payme',
        secrets: { merchantId: MERCHANT_ID, key: MERCHANT_KEY },
        isEnabled: true,
      }),
    );
  });

  it('reports which credentials are set, never their values', async () => {
    const saved = await asA(() =>
      integrations.upsert(USER_A, { type: 'PAYMENT', provider: 'payme', isEnabled: true }),
    );

    expect(saved.configuredCredentials).toEqual(expect.arrayContaining(['merchantId', 'key']));
    expect(JSON.stringify(saved)).not.toContain(MERCHANT_KEY);
  });

  it('keeps the secret out of the integrations list the admin UI renders', async () => {
    const listed = await asA(() => integrations.list());
    const body = JSON.stringify(listed);

    expect(body).not.toContain(MERCHANT_KEY);
    expect(body).not.toContain(MERCHANT_ID);
    // The row is still reported as connected — the point is confidentiality, not silence.
    expect(listed.find((i) => i.provider === 'payme')?.connected).toBe(true);
  });

  it('stores it encrypted, so a database dump does not hand it over', async () => {
    const row = await raw.integration.findFirstOrThrow({
      where: { tenantId: TENANT_A, provider: 'payme' },
    });

    expect(row.secretCipher).toBeTruthy();
    expect(row.secretCipher).not.toContain(MERCHANT_KEY);
    expect(JSON.stringify(row)).not.toContain(MERCHANT_KEY);
    // AES-256-GCM: without the iv and the auth tag the ciphertext is neither readable
    // nor modifiable undetected.
    expect(row.secretIv).toBeTruthy();
    expect(row.secretTag).toBeTruthy();
  });

  it('merges an edit instead of wiping the credentials that were not retyped', async () => {
    // An admin changing only the public config must not silently disconnect payments.
    await asA(() =>
      integrations.upsert(USER_A, {
        type: 'PAYMENT',
        provider: 'payme',
        config: { label: 'Payme' },
      }),
    );

    const listed = await asA(() => integrations.list());
    const payme = listed.find((i) => i.provider === 'payme');
    expect(payme?.configuredCredentials).toEqual(expect.arrayContaining(['merchantId', 'key']));
    expect(JSON.stringify(listed)).not.toContain(MERCHANT_KEY);
  });

  it('refuses a half-configured provider rather than failing at the customer', async () => {
    await expect(
      asB(() =>
        integrations.upsert(USER_A, {
          type: 'PAYMENT',
          provider: 'click',
          secrets: { serviceId: '12345' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('does not expose tenant A\u2019s integration to tenant B', async () => {
    const listedForB = await asB(() => integrations.list());
    expect(JSON.stringify(listedForB)).not.toContain(MERCHANT_KEY);
    expect(listedForB.find((i) => i.provider === 'payme')?.connected).toBe(false);
  });
});

/** A slot N days out at 12:00 UTC, comfortably inside the seeded working hours. */
function nextSlot(daysAhead = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(6, 0, 0, 0); // 11:00 in Asia/Tashkent
  return d.toISOString();
}
