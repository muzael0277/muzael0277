import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyTenantGuard } from '../tenant-guard';
import { tenantContext } from '../tenant-context';
import { CrossTenantWriteError, MissingTenantContextError } from '../errors';

/**
 * Invariant I1 — tenant isolation.
 *
 * These run against a real PostgreSQL database, because the guard rewrites queries and
 * a mock would only prove that the mock agrees with itself. Read
 * docs/architecture/02-tenant-isolation.md for what each layer is responsible for.
 */

const base = new PrismaClient({
  datasources: { db: { url: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL! } },
  log: ['error'],
});
const prisma = applyTenantGuard(base);

const TENANT_A = '0a000000-0000-4000-8000-00000000000a';
const TENANT_B = '0b000000-0000-4000-8000-00000000000b';

const asA = <T>(fn: () => Promise<T>) => tenantContext.run({ tenantId: TENANT_A }, fn);
const asB = <T>(fn: () => Promise<T>) => tenantContext.run({ tenantId: TENANT_B }, fn);
const asSystem = <T>(fn: () => Promise<T>) => tenantContext.runAsSystem('test-fixture', fn);

let productA: string;
let productB: string;
let customerA: string;

beforeAll(async () => {
  await asSystem(async () => {
    await base.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    for (const [id, slug] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
      await base.tenant.create({
        data: { id, slug, name: slug, templateKey: 'ONLINE_STORE', status: 'ACTIVE' },
      });
    }
  });
});

beforeEach(async () => {
  await asSystem(async () => {
    await base.product.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await base.customer.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });

    productA = (await base.product.create({
      data: { tenantId: TENANT_A, name: { uz: 'A mahsuloti' }, price: 10000 },
    })).id;
    productB = (await base.product.create({
      data: { tenantId: TENANT_B, name: { uz: 'B mahsuloti' }, price: 20000 },
    })).id;
    customerA = (await base.customer.create({
      data: { tenantId: TENANT_A, firstName: 'Aziz' },
    })).id;
  });
});

afterAll(async () => {
  await asSystem(async () => {
    await base.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  });
  await base.$disconnect();
});

describe('reads', () => {
  it('returns only the current tenant rows from findMany', async () => {
    const seen = await asA(() => prisma.product.findMany());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(productA);
  });

  it('does not let a row id act as a capability (findUnique is scoped)', async () => {
    // The single most commonly missed isolation hole: an id leaked in a URL must not
    // be enough to read another tenant's row.
    const stolen = await asA(() => prisma.product.findUnique({ where: { id: productB } }));
    expect(stolen).toBeNull();
  });

  it('throws from findUniqueOrThrow rather than returning a foreign row', async () => {
    await expect(
      asA(() => prisma.product.findUniqueOrThrow({ where: { id: productB } })),
    ).rejects.toThrow();
  });

  it('cannot be widened by an OR clause in the caller where', async () => {
    // A naive `{...where, tenantId}` merge would let this OR escape the tenant filter.
    const seen = await asA(() =>
      prisma.product.findMany({
        where: { OR: [{ id: productA }, { id: productB }] },
      }),
    );
    expect(seen.map((p) => p.id)).toEqual([productA]);
  });

  it('cannot be widened by the caller supplying another tenantId', async () => {
    const seen = await asA(() => prisma.product.findMany({ where: { tenantId: TENANT_B } }));
    expect(seen).toHaveLength(0);
  });

  it('scopes count and aggregate', async () => {
    expect(await asA(() => prisma.product.count())).toBe(1);
    const agg = await asA(() => prisma.product.aggregate({ _sum: { price: true } }));
    expect(agg._sum.price).toBe(10000);
  });

  it('scopes groupBy', async () => {
    const groups = await asA(() =>
      prisma.product.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tenantId).toBe(TENANT_A);
  });
});

describe('writes', () => {
  it('stamps the current tenant on create', async () => {
    const created = await asA(() =>
      prisma.product.create({ data: { name: { uz: 'Yangi' }, price: 5000 } as never }),
    );
    expect(created.tenantId).toBe(TENANT_A);
  });

  it('refuses a create that names a different tenant', async () => {
    await expect(
      asA(() =>
        prisma.product.create({
          data: { tenantId: TENANT_B, name: { uz: 'Yomon' }, price: 1 } as never,
        }),
      ),
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it('refuses createMany when any row names a different tenant', async () => {
    await expect(
      asA(() =>
        prisma.product.createMany({
          data: [
            { name: { uz: 'Yaxshi' }, price: 1 },
            { tenantId: TENANT_B, name: { uz: 'Yomon' }, price: 1 },
          ] as never,
        }),
      ),
    ).rejects.toThrow(CrossTenantWriteError);
  });

  it('cannot update another tenant row, even with its exact id', async () => {
    await expect(
      asA(() => prisma.product.update({ where: { id: productB }, data: { price: 1 } })),
    ).rejects.toThrow();

    const untouched = await asSystem(() =>
      base.product.findUniqueOrThrow({ where: { id: productB } }),
    );
    expect(untouched.price).toBe(20000);
  });

  it('cannot delete another tenant row', async () => {
    await expect(
      asA(() => prisma.product.delete({ where: { id: productB } })),
    ).rejects.toThrow();

    expect(
      await asSystem(() => base.product.count({ where: { id: productB } })),
    ).toBe(1);
  });

  it('affects zero rows when updateMany targets another tenant', async () => {
    const result = await asA(() =>
      prisma.product.updateMany({ where: { id: productB }, data: { price: 1 } }),
    );
    expect(result.count).toBe(0);
  });

  it('does not let deleteMany with an empty where wipe other tenants', async () => {
    await asA(() => prisma.product.deleteMany({}));
    expect(await asSystem(() => base.product.count({ where: { tenantId: TENANT_B } }))).toBe(1);
  });
});

describe('cross-tenant relationships', () => {
  it('refuses to create a cart item pointing at another tenant product', async () => {
    // The subtler leak: the row is written under tenant A but references B's data.
    // The composite (tenantId, productId) foreign key makes the database reject it.
    const cart = await asA(() =>
      prisma.cart.create({ data: { customerId: customerA } as never }),
    );

    await expect(
      asA(() =>
        prisma.cartItem.create({
          data: { cartId: cart.id, productId: productB, quantity: 1 } as never,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('fail-closed behaviour', () => {
  it('refuses to query a tenant-scoped model with no context at all', async () => {
    await expect(prisma.product.findMany()).rejects.toThrow(MissingTenantContextError);
  });

  it('refuses to write with no context, rather than writing unscoped', async () => {
    await expect(
      prisma.product.create({ data: { name: { uz: 'X' }, price: 1 } as never }),
    ).rejects.toThrow(MissingTenantContextError);
  });

  it('still allows non-tenant models without context', async () => {
    await expect(prisma.plan.findMany()).resolves.toBeInstanceOf(Array);
  });

  it('sees across tenants only in an explicit system context', async () => {
    const all = await asSystem(() =>
      prisma.product.findMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } }),
    );
    expect(all).toHaveLength(2);
  });

  it('keeps contexts isolated across concurrent async work', async () => {
    // The guard relies on AsyncLocalStorage; interleaved requests must not bleed.
    const [a, b] = await Promise.all([
      asA(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return prisma.product.findMany();
      }),
      asB(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return prisma.product.findMany();
      }),
    ]);
    expect(a.map((p) => p.id)).toEqual([productA]);
    expect(b.map((p) => p.id)).toEqual([productB]);
  });
});

describe('guarded model registry', () => {
  it('derives the guarded set from the schema so a new model is protected by default', async () => {
    const { tenantGuardInternals } = await import('../tenant-guard');
    const scoped = tenantGuardInternals.buildScopedModelSet();

    for (const model of ['Customer', 'Order', 'Booking', 'Product', 'Payment', 'AuditLog']) {
      expect(scoped.has(model), model).toBe(true);
    }
    // Platform-level models must not be scoped, or the platform surface breaks.
    for (const model of ['User', 'Plan', 'FeatureFlag', 'BusinessTemplate']) {
      expect(scoped.has(model), model).toBe(false);
    }
  });
});

describe('composite-unique writes', () => {
  /**
   * Regression: the guard originally wrapped every write `where` in an AND, which Prisma
   * rejects for update/delete/upsert because those need a valid WhereUniqueInput. It
   * surfaced as an opaque 500 when a tenant toggled a module — the sort of bug that only
   * appears once the code is actually exercised.
   */
  it('upserts on a composite unique key without breaking the where clause', async () => {
    const upserted = await asA(() =>
      prisma.tenantModule.upsert({
        where: { tenantId_module: { tenantId: TENANT_A, module: 'CATALOG' } },
        create: { module: 'CATALOG', enabled: true } as never,
        update: { enabled: true },
      }),
    );
    expect(upserted.enabled).toBe(true);
    expect(upserted.tenantId).toBe(TENANT_A);
  });

  it('still refuses an upsert aimed at another tenant', async () => {
    await expect(
      asA(() =>
        prisma.tenantModule.upsert({
          where: { tenantId_module: { tenantId: TENANT_B, module: 'ORDERS' } },
          create: { module: 'ORDERS', enabled: true } as never,
          update: { enabled: true },
        }),
      ),
    ).rejects.toThrow();

    expect(
      await asSystem(() => base.tenantModule.count({ where: { tenantId: TENANT_B } })),
    ).toBe(0);
  });

  it('updates by a plain id without an AND wrapper', async () => {
    const updated = await asA(() =>
      prisma.product.update({ where: { id: productA }, data: { price: 12345 } }),
    );
    expect(updated.price).toBe(12345);
  });
});

describe('raw SQL is not covered by the guard', () => {
  /**
   * The guard rewrites the query builder's arguments; a raw query has none, so it runs
   * completely unscoped. This is not a defect in the guard — it is a property of raw SQL,
   * and the only defence is that every raw query carries its own tenant predicate.
   *
   * These tests pin that down: the first documents the hazard so nobody assumes raw
   * queries are safe, the second asserts the shape every raw query in the codebase must
   * have. A raw query added without a tenant filter is a cross-tenant hole (risk R13),
   * and one was found in the loyalty service exactly this way.
   */
  it('a raw query without a tenant predicate sees every tenant', async () => {
    const rows = await asA(() =>
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Product" WHERE id IN (${productA}, ${productB})
      `,
    );
    // Two rows, from two different tenants, while scoped to tenant A.
    expect(rows).toHaveLength(2);
  });

  it('a raw query with an explicit tenant predicate is correctly scoped', async () => {
    const rows = await asA(() =>
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Product"
        WHERE id IN (${productA}, ${productB})
          AND "tenantId" = ${TENANT_A}
      `,
    );
    expect(rows.map((r) => r.id)).toEqual([productA]);
  });
});

describe('the Tenant model scopes on its own id', () => {
  /**
   * Tenant has no `tenantId` column — its primary key *is* the tenant. Before the guard
   * knew that, the model fell outside scoping entirely and `tenant.findFirst()` returned
   * whichever row happened to come first. Services that call it to read the timezone or
   * settings were therefore reading an arbitrary business's configuration.
   */
  it('findFirst returns the current tenant, not an arbitrary one', async () => {
    const fromA = await asA(() => prisma.tenant.findFirstOrThrow());
    const fromB = await asB(() => prisma.tenant.findFirstOrThrow());
    expect(fromA.id).toBe(TENANT_A);
    expect(fromB.id).toBe(TENANT_B);
  });

  it('cannot read another tenant by id', async () => {
    expect(await asA(() => prisma.tenant.findUnique({ where: { id: TENANT_B } }))).toBeNull();
  });

  it('cannot rename another tenant', async () => {
    await expect(
      asA(() => prisma.tenant.update({ where: { id: TENANT_B }, data: { name: 'Hijacked' } })),
    ).rejects.toThrow();

    const untouched = await asSystem(() => base.tenant.findUniqueOrThrow({ where: { id: TENANT_B } }));
    expect(untouched.name).toBe('tenant-b');
  });

  it('counts only the current tenant', async () => {
    expect(await asA(() => prisma.tenant.count())).toBe(1);
  });

  it('still allows tenant creation in system context, where no tenant exists yet', async () => {
    const created = await asSystem(() =>
      prisma.tenant.create({
        data: { slug: 'guard-test-new', name: 'New', templateKey: 'CUSTOM' } as never,
      }),
    );
    expect(created.slug).toBe('guard-test-new');
    await asSystem(() => base.tenant.delete({ where: { id: created.id } }));
  });
});
