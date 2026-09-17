#!/usr/bin/env node
/**
 * Data integrity check.
 *
 * The invariants are enforced in code and, where possible, by database constraints.
 * This asks the other question: given whatever is actually stored right now, does any
 * of it violate them? It runs against the seeded demo data in CI, and is the first
 * thing to run against a production snapshot when something looks wrong.
 *
 * Read-only. Exits non-zero, and prints the offending rows, if anything is off.
 *
 *   pnpm db:check
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Each check is a query that should return no rows. Naming the invariant matters: a
 * failure here needs to point at the rule that broke, not just at a count.
 */
const CHECKS = [
  {
    invariant: 'I5',
    name: 'loyalty balance equals the sum of its ledger',
    query: () => prisma.$queryRaw`
      SELECT a."id", a."tenantId", a."balance",
             COALESCE(SUM(t."amount"), 0)::int AS "ledgerSum"
      FROM "LoyaltyAccount" a
      LEFT JOIN "LoyaltyTransaction" t ON t."accountId" = a."id"
      GROUP BY a."id", a."tenantId", a."balance"
      HAVING a."balance" <> COALESCE(SUM(t."amount"), 0)::int
    `,
  },
  {
    invariant: 'I5',
    name: 'loyalty amounts carry the sign their type implies',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "type", "amount" FROM "LoyaltyTransaction"
      WHERE ("type" IN ('EARN', 'REFUND') AND "amount" < 0)
         OR ("type" IN ('SPEND', 'EXPIRE') AND "amount" > 0)
    `,
  },
  {
    invariant: 'I5',
    name: 'no loyalty balance is negative',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "balance" FROM "LoyaltyAccount" WHERE "balance" < 0
    `,
  },
  {
    invariant: 'I4',
    name: 'at most one cashback accrual per order',
    query: () => prisma.$queryRaw`
      SELECT "orderId", "type", COUNT(*)::int AS "count"
      FROM "LoyaltyTransaction"
      WHERE "orderId" IS NOT NULL
      GROUP BY "orderId", "type"
      HAVING COUNT(*) > 1
    `,
  },
  {
    invariant: 'I2',
    name: 'order totals reconcile with their own components',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "subtotal", "discountTotal", "deliveryFee", "taxTotal", "total"
      FROM "Order"
      WHERE "total" <> "subtotal" - "discountTotal" + "deliveryFee" + "taxTotal"
    `,
  },
  {
    invariant: 'I2',
    // Subtotal is the gross figure, before any discount. Line `total` is already net of
    // the line's share of the order discount, so comparing against that instead would
    // flag every discounted order — the difference is the discount, not a bug.
    name: 'order subtotals equal the gross sum of their line items',
    query: () => prisma.$queryRaw`
      SELECT o."id", o."tenantId", o."subtotal",
             COALESCE(SUM((i."unitPrice" + i."modifiersPrice") * i."quantity"), 0)::int
               AS "grossLineSum"
      FROM "Order" o
      LEFT JOIN "OrderItem" i ON i."orderId" = o."id"
      GROUP BY o."id", o."tenantId", o."subtotal"
      HAVING o."subtotal"
             <> COALESCE(SUM((i."unitPrice" + i."modifiersPrice") * i."quantity"), 0)::int
    `,
  },
  {
    invariant: 'I2',
    // The order discount is spread across lines by largest remainder so the parts sum
    // back to the whole; a rounding bug there shows up here as a so'm going missing.
    name: 'line discounts sum back to the order discount',
    query: () => prisma.$queryRaw`
      SELECT o."id", o."tenantId", o."discountTotal",
             COALESCE(SUM(i."discount"), 0)::int AS "lineDiscountSum"
      FROM "Order" o
      LEFT JOIN "OrderItem" i ON i."orderId" = o."id"
      GROUP BY o."id", o."tenantId", o."discountTotal"
      HAVING o."discountTotal" <> COALESCE(SUM(i."discount"), 0)::int
    `,
  },
  {
    invariant: 'I2',
    name: 'line totals equal unit price times quantity, less the line discount',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "unitPrice", "modifiersPrice", "quantity", "discount", "total"
      FROM "OrderItem"
      WHERE "total" <> ("unitPrice" + "modifiersPrice") * "quantity" - "discount"
    `,
  },
  {
    invariant: 'I2',
    name: 'no order discount exceeds its own subtotal',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "subtotal", "discountTotal" FROM "Order"
      WHERE "discountTotal" > "subtotal" OR "discountTotal" < 0 OR "total" < 0
    `,
  },
  {
    invariant: 'I3',
    name: 'no two live bookings overlap on one resource',
    query: () => prisma.$queryRaw`
      SELECT a."id" AS "bookingA", b."id" AS "bookingB", a."tenantId", a."resourceId"
      FROM "Booking" a
      JOIN "Booking" b
        ON b."tenantId" = a."tenantId"
       AND b."resourceId" = a."resourceId"
       AND b."id" > a."id"
       AND b."blockStartsAt" < a."blockEndsAt"
       AND a."blockStartsAt" < b."blockEndsAt"
      WHERE a."status" NOT IN ('CANCELLED', 'NO_SHOW')
        AND b."status" NOT IN ('CANCELLED', 'NO_SHOW')
    `,
  },
  {
    invariant: 'I3',
    name: 'every booking ends after it starts, and its block contains it',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "startsAt", "endsAt", "blockStartsAt", "blockEndsAt"
      FROM "Booking"
      WHERE "endsAt" <= "startsAt"
         OR "blockStartsAt" > "startsAt"
         OR "blockEndsAt" < "endsAt"
    `,
  },
  {
    invariant: 'I1',
    name: 'no order item belongs to a different tenant than its order',
    query: () => prisma.$queryRaw`
      SELECT i."id", i."tenantId" AS "itemTenant", o."tenantId" AS "orderTenant"
      FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId"
      WHERE i."tenantId" <> o."tenantId"
    `,
  },
  {
    invariant: 'I1',
    name: 'no order references a customer from another tenant',
    query: () => prisma.$queryRaw`
      SELECT o."id", o."tenantId" AS "orderTenant", c."tenantId" AS "customerTenant"
      FROM "Order" o JOIN "Customer" c ON c."id" = o."customerId"
      WHERE o."tenantId" <> c."tenantId"
    `,
  },
  {
    invariant: 'I1',
    name: 'no booking references a service or resource from another tenant',
    query: () => prisma.$queryRaw`
      SELECT b."id", b."tenantId",
             s."tenantId" AS "serviceTenant", r."tenantId" AS "resourceTenant"
      FROM "Booking" b
      JOIN "Service" s ON s."id" = b."serviceId"
      JOIN "BookingResource" r ON r."id" = b."resourceId"
      WHERE b."tenantId" <> s."tenantId" OR b."tenantId" <> r."tenantId"
    `,
  },
  {
    invariant: 'I1',
    name: 'no loyalty transaction belongs to a different tenant than its account',
    query: () => prisma.$queryRaw`
      SELECT t."id", t."tenantId" AS "txTenant", a."tenantId" AS "accountTenant"
      FROM "LoyaltyTransaction" t JOIN "LoyaltyAccount" a ON a."id" = t."accountId"
      WHERE t."tenantId" <> a."tenantId"
    `,
  },
  {
    invariant: 'I6',
    name: 'every order item kept its name snapshot',
    query: () => prisma.$queryRaw`
      SELECT "id", "tenantId", "orderId" FROM "OrderItem"
      WHERE "nameSnapshot" IS NULL OR "nameSnapshot"::text IN ('null', '{}')
    `,
  },
  {
    invariant: 'I6',
    name: 'order numbers are unique within a tenant',
    query: () => prisma.$queryRaw`
      SELECT "tenantId", "orderNumber", COUNT(*)::int AS "count" FROM "Order"
      GROUP BY "tenantId", "orderNumber" HAVING COUNT(*) > 1
    `,
  },
];

/** BigInt does not survive JSON.stringify, and these rows are only ever printed. */
const replacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

async function main() {
  let failures = 0;

  for (const check of CHECKS) {
    let rows;
    try {
      rows = await check.query();
    } catch (error) {
      console.error(`✗ ${check.invariant}  ${check.name}`);
      console.error(`    query failed: ${error.message.split('\n')[0]}`);
      failures += 1;
      continue;
    }

    if (rows.length === 0) {
      console.log(`✓ ${check.invariant}  ${check.name}`);
      continue;
    }

    failures += 1;
    console.error(`✗ ${check.invariant}  ${check.name} — ${rows.length} violation(s)`);
    for (const row of rows.slice(0, 5)) {
      console.error(`    ${JSON.stringify(row, replacer)}`);
    }
    if (rows.length > 5) console.error(`    … and ${rows.length - 5} more`);
  }

  console.log(`\n${CHECKS.length - failures}/${CHECKS.length} checks passed`);
  if (failures > 0) {
    console.error('\nStored data violates an invariant. Do not deploy over this.');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
