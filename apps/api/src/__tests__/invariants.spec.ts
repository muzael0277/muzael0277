import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  // Tenants own audit rows, which are append-only, so removal goes through the
  // deliberate purge path rather than a bare deleteMany.
  await purgeTenants();
  await raw.user.deleteMany({ where: { id: USER_A } });

  for (const [id, slug] of [[TENANT_A, 'inv-a'], [TENANT_B, 'inv-b']] as const) {
    await raw.tenant.create({
      data: {
        id, slug, name: slug, templateKey: 'RESTAURANT', status: 'ACTIVE', currency: 'UZS',
        settings: {
          create: {
            workingHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '09:00', end: '21:00' }]])),
            deliverySettings: { enabled: true, flatFee: 15000, freeAbove: 200000, minOrderTotal: 0 },
            loyaltySettings: { enabled: true, type: 'CASHBACK', rate: 10, minOrderTotal: 0, maxRedeemPercent: 50 },
            bookingSettings: { slotStepMinutes: 30, minLeadTimeMinutes: 0, maxAdvanceDays: 60, autoConfirm: true, cancellationDeadlineMinutes: 60, reminderOffsetsMinutes: [] },
          },
        },
        modules: {
          create: ['CRM', 'CATALOG', 'SERVICES', 'ORDERS', 'BOOKING', 'LOYALTY', 'PAYMENTS', 'ANALYTICS', 'TELEGRAM', 'EMPLOYEES']
            .map((module) => ({ module, enabled: true })),
        },
      },
    });
  }

  await raw.user.create({
    data: {
      id: USER_A, email: 'inv-a@test.local', passwordHash: 'x',
      memberships: { create: { tenantId: TENANT_A, role: 'OWNER' } },
    },
  });

  productA = (await asA(() => catalog.createProduct(USER_A, {
    name: { uz: 'Test osh' }, price: 50_000, isActive: true,
  }))).id;

  customerA = (await raw.customer.create({
    data: { tenantId: TENANT_A, firstName: 'Aziz', loyaltyAccount: { create: { tenantId: TENANT_A } } },
  })).id;
  customerB = (await raw.customer.create({
    data: { tenantId: TENANT_B, firstName: 'Rival', loyaltyAccount: { create: { tenantId: TENANT_B } } },
  })).id;

  serviceA = (await asA(() => services.create(USER_A, {
    name: { uz: 'Soch olish' }, price: 100_000, durationMinutes: 60, isActive: true,
  }))).id;

  const employee = await asA(() => branches.createEmployee(USER_A, {
    firstName: 'Jamshid',
    serviceIds: [serviceA],
    schedule: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '21:00' })),
  }));
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
      asB(() => cart.addItem(customerB, { productId: productA, quantity: 1, modifierOptionIds: [] })),
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
      asB(() => bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt: nextSlot(), customerId: customerB },
        { userId: USER_A },
      )),
    ).rejects.toThrow();
  });
});

// ── I2 ────────────────────────────────────────────────────────────────────────

describe('I2 — the server prices every order', () => {
  it('ignores prices supplied by the client', async () => {
    const order = await asA(() => orders.createByStaff(USER_A, {
      customerId: customerA,
      fulfillmentType: 'PICKUP',
      paymentMethod: 'CASH',
      items: [
        // Every money field here is a lie the client is telling.
        { productId: productA, quantity: 2, modifierOptionIds: [], price: 1, unitPrice: 1, total: 2 } as never,
      ],
    }));

    expect(order.subtotal).toBe(100_000);
    expect(order.total).toBe(100_000);
    expect(order.items[0]!.unitPrice).toBe(50_000);
  });

  it('keeps a snapshot so a later price change cannot rewrite history', async () => {
    const order = await asA(() => orders.createByStaff(USER_A, {
      customerId: customerA, fulfillmentType: 'PICKUP', paymentMethod: 'CASH',
      items: [{ productId: productA, quantity: 1, modifierOptionIds: [] }],
    }));

    await asA(() => catalog.updateProduct(USER_A, productA, { price: 999_000 }));

    const reloaded = await asA(() => orders.detail(order.id));
    expect(reloaded.items[0]!.unitPrice).toBe(50_000);
    expect(reloaded.total).toBe(50_000);

    await asA(() => catalog.updateProduct(USER_A, productA, { price: 50_000 }));
  });

  it('keeps line totals reconciled with the order total', async () => {
    const order = await asA(() => orders.createByStaff(USER_A, {
      customerId: customerA, fulfillmentType: 'PICKUP', paymentMethod: 'CASH',
      items: [
        { productId: productA, quantity: 3, modifierOptionIds: [] },
        { productId: productA, quantity: 1, modifierOptionIds: [] },
      ],
    }));
    const lineSum = order.items.reduce((sum, i) => sum + i.total, 0);
    expect(lineSum).toBe(order.subtotal - order.discountTotal);
  });
});

// ── I3 ────────────────────────────────────────────────────────────────────────

describe('I3 — a resource cannot be double-booked', () => {
  it('lets exactly one of several concurrent requests win', async () => {
    const startsAt = nextSlot(3);

    const attempts = Array.from({ length: 6 }, () =>
      asA(() => bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
        { userId: USER_A },
      )).then(
        (booking) => ({ ok: true as const, booking }),
        (error: Error) => ({ ok: false as const, error }),
      ),
    );

    const results = await Promise.all(attempts);
    const created = results.filter((r) => r.ok);
    expect(created).toHaveLength(1);

    const stored = await raw.booking.count({
      where: { resourceId: resourceA, startsAt: new Date(startsAt), status: { notIn: ['CANCELLED'] } },
    });
    expect(stored).toBe(1);
  }, 30_000);

  it('rejects an overlapping booking even when the start times differ', async () => {
    const base = nextSlot(5);
    await asA(() => bookings.create(
      { serviceId: serviceA, resourceId: resourceA, startsAt: base, customerId: customerA },
      { userId: USER_A },
    ));

    // 30 minutes into a 60-minute appointment.
    const overlapping = new Date(new Date(base).getTime() + 30 * 60_000).toISOString();
    await expect(
      asA(() => bookings.create(
        { serviceId: serviceA, resourceId: resourceA, startsAt: overlapping, customerId: customerA },
        { userId: USER_A },
      )),
    ).rejects.toMatchObject({ code: 'BOOKING_SLOT_TAKEN' });
  }, 20_000);

  it('frees the slot again when the booking is cancelled', async () => {
    const startsAt = nextSlot(7);
    const booking = await asA(() => bookings.create(
      { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
      { userId: USER_A },
    ));

    await asA(() => bookings.updateStatus(booking.id, 'CANCELLED', { userId: USER_A }));

    const replacement = await asA(() => bookings.create(
      { serviceId: serviceA, resourceId: resourceA, startsAt, customerId: customerA },
      { userId: USER_A },
    ));
    expect(replacement.id).not.toBe(booking.id);
  }, 20_000);
});

// ── I5 ────────────────────────────────────────────────────────────────────────

describe('I5 — a loyalty balance always equals its ledger', () => {
  it('moves the balance and the ledger together', async () => {
    await asA(() => loyalty.adjust(USER_A, customerA, 5_000, 'goodwill'));
    await asA(() => loyalty.adjust(USER_A, customerA, 2_500, 'goodwill again'));
    await asA(() => loyalty.adjust(USER_A, customerA, -1_500, 'correction'));

    const account = await raw.loyaltyAccount.findFirstOrThrow({ where: { customerId: customerA } });
    const ledger = await raw.loyaltyTransaction.aggregate({
      where: { accountId: account.id }, _sum: { amount: true },
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
      where: { accountId: after.id }, _sum: { amount: true },
    });

    // Without the FOR UPDATE lock these would read the same balance and lose increments.
    expect(after.balance).toBe(before.balance + 5_000);
    expect(after.balance).toBe(ledger._sum.amount);
  }, 20_000);
});

/** A slot N days out at 12:00 UTC, comfortably inside the seeded working hours. */
function nextSlot(daysAhead = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(6, 0, 0, 0); // 11:00 in Asia/Tashkent
  return d.toISOString();
}
