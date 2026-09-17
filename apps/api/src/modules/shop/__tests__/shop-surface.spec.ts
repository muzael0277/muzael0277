import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { tenantContext, type PrismaClient } from '@bizbot/database';
import { checkoutSchema } from '@bizbot/contracts';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../infra/prisma.service';
import { ShopController } from '../shop.controller';
import { CatalogService } from '../../catalog/catalog.service';
import { BranchesService } from '../../branches/branches.service';

/**
 * The customer-facing surface, tested where it actually broke.
 *
 * Both cases below shipped: the Mini App's cart page crashed the moment it held an
 * item, and pickup checkout could never succeed. Neither was visible from the API's
 * own tests, because both are about the *shape* the customer surface returns and the
 * contract it has to satisfy — not about whether a service computed the right number.
 */

let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
let prisma: PrismaService;
let raw: PrismaClient;
let shop: ShopController;
let catalog: CatalogService;
let branches: BranchesService;

const TENANT = 'cc000000-0000-4000-8000-0000000000cc';
const USER = 'c1000000-0000-4000-8000-0000000000c1';
const asTenant = <T>(fn: () => Promise<T>) => tenantContext.run({ tenantId: TENANT }, fn);

let customerId: string;
let productId: string;
let branchId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef;
  await moduleRef.init();

  prisma = moduleRef.get(PrismaService);
  raw = prisma.raw;
  shop = moduleRef.get(ShopController);
  catalog = moduleRef.get(CatalogService);
  branches = moduleRef.get(BranchesService);

  await purge();

  await raw.tenant.create({
    data: {
      id: TENANT,
      slug: 'shop-surface',
      name: 'Shop Surface',
      templateKey: 'RESTAURANT',
      status: 'ACTIVE',
      currency: 'UZS',
      settings: {
        create: {
          workingHours: Object.fromEntries(
            [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '09:00', end: '21:00' }]]),
          ),
          deliverySettings: { enabled: true, flatFee: 15000, freeAbove: 200000, minOrderTotal: 0 },
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
        create: ['CRM', 'CATALOG', 'ORDERS', 'PAYMENTS', 'BRANCHES', 'LOYALTY'].map((module) => ({
          module,
          enabled: true,
        })),
      },
    },
  });

  const branch = await asTenant(() =>
    branches.createBranch(USER, { name: 'Markaziy filial', address: 'Amir Temur 1' }),
  );
  branchId = branch.id;

  // A product whose name exists in two languages — the exact shape that broke rendering.
  const product = await asTenant(() =>
    catalog.createProduct(USER, {
      name: { uz: 'Osh', ru: 'Плов' },
      price: 35_000,
      isActive: true,
    } as never),
  );
  productId = product.id;

  const customer = await raw.customer.create({
    data: { tenantId: TENANT, firstName: 'Dilshod', phone: '998907770077', language: 'uz' },
  });
  customerId = customer.id;
});

afterAll(async () => {
  await purge();
  await app?.close();
});

async function purge() {
  await raw.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL bizbot.allow_audit_purge = 'on'`;
    await tx.tenant.deleteMany({ where: { id: TENANT } });
  });
}

const actor = () => ({ customerId, tenantId: TENANT }) as never;

describe('the shop surface returns text, not translation objects', () => {
  it('resolves the product name in the cart', async () => {
    // `{uz, ru}` reaching the Mini App is not a cosmetic problem: React refuses to
    // render an object as a child, so the cart page white-screened with
    // "Objects are not valid as a React child" as soon as it held one item.
    const added = await asTenant(() =>
      shop.addItem(actor(), 'uz', { productId, quantity: 2, modifierOptionIds: [] } as never),
    );

    const item = added.cart.items[0]!;
    expect(typeof item.name).toBe('string');
    expect(item.name).toBe('Osh');
  });

  it('resolves it in Russian for a Russian-speaking customer', async () => {
    const cart = await asTenant(() => shop.getCart(actor(), 'ru', 'PICKUP'));
    expect(cart.cart.items[0]!.name).toBe('Плов');
  });

  it('leaves no translation object anywhere in the cart response', async () => {
    const cart = await asTenant(() => shop.getCart(actor(), 'uz', 'DELIVERY'));

    // A blanket check, because the next field someone adds will have the same trap.
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        const looksTranslated =
          keys.length > 0 && keys.every((k) => ['uz', 'ru', 'en'].includes(k));
        expect(looksTranslated, `${path} is a translation object`).toBe(false);
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(cart, 'cart');
  });
});

describe('pickup checkout', () => {
  it('is refused without a branch — which is what the Mini App used to send', () => {
    // The cart page hard-coded `branchId: undefined`, so every customer who chose
    // "Olib ketish" got a validation error and no order. The contract was right; the
    // client was wrong, and nothing connected the two.
    const parsed = checkoutSchema.safeParse({
      fulfillmentType: 'PICKUP',
      paymentMethod: 'CASH',
      useLoyaltyAmount: 0,
      branchId: undefined,
    });
    expect(parsed.success).toBe(false);
  });

  it('succeeds with one, and the order records it', async () => {
    const payload = checkoutSchema.parse({
      fulfillmentType: 'PICKUP',
      paymentMethod: 'CASH',
      useLoyaltyAmount: 0,
      branchId,
      phone: '998907770077',
    });

    const order = await asTenant(() => shop.checkout(actor(), payload as never));
    expect(order.branchId).toBe(branchId);
    expect(order.fulfillmentType).toBe('PICKUP');
    // Pickup carries no delivery fee, whatever the delivery settings say.
    expect(order.deliveryFee).toBe(0);
    expect(order.total).toBe(70_000);
  });
});
