/**
 * Demo seed.
 *
 * Produces three browsable businesses with realistic Uzbek names, prices and history,
 * so the platform can be demonstrated to a client or an investor without connecting a
 * real Telegram bot or payment credentials.
 *
 * Demo tenants are flagged `isDemo` and excluded from platform analytics and billing
 * (risk R14). Seeding refuses to run against production.
 */

import { PrismaClient, type MemberRole, type Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { TEMPLATE_DEFINITIONS, withDependencies, type BusinessTemplateKey } from '@bizbot/rbac';
import { distributeProportionally, formatOrderNumber } from '@bizbot/shared';
import { randomCode } from '@bizbot/shared/server';

const prisma = new PrismaClient();

// The seed writes across tenants by definition, so it runs outside the guard using the
// raw client. This is one of the three sanctioned places that is allowed.

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'yes') {
  console.error(
    'Refusing to seed a production database. Set ALLOW_PRODUCTION_SEED=yes to override.',
  );
  process.exit(1);
}

/**
 * Must match the API's hashing exactly, or the demo accounts cannot log in — which is
 * the whole point of seeding them. Keeping these in step is worth the native dependency.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

function seedPasswordHash(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

const DEMO_PASSWORD = 'BizBotDemo2026';

// ── helpers ────────────────────────────────────────────────────────────────────

const uz = (uzText: string, ruText?: string) => ({ uz: uzText, ...(ruText ? { ru: ruText } : {}) });

/** A date N days ago, at a given local hour in Tashkent (UTC+5). */
function daysAgo(days: number, hourLocal = 12): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hourLocal - 5, 0, 0, 0);
  return d;
}

function daysAhead(days: number, hourLocal = 12, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourLocal - 5, minute, 0, 0);
  return d;
}

const FULL_WEEK_HOURS = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '09:00', end: '22:00' }]]),
);

const WORKDAY_HOURS = Object.fromEntries(
  [1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '10:00', end: '20:00' }]]),
);

// ── platform-level fixtures ────────────────────────────────────────────────────

async function seedPlans() {
  const plans = [
    {
      key: 'FREE',
      name: uz('Bepul', 'Бесплатный'),
      monthlyPrice: 0,
      sortOrder: 0,
      features: {
        orders_per_month: 50,
        products: 30,
        employees: 2,
        branches: 1,
        advanced_analytics: false,
        ai_assistant: false,
        marketing_automation: false,
        custom_domain: false,
      },
    },
    {
      key: 'START',
      name: uz('Boshlang‘ich', 'Стартовый'),
      monthlyPrice: 149000,
      sortOrder: 1,
      features: {
        orders_per_month: 500,
        products: 300,
        employees: 5,
        branches: 2,
        advanced_analytics: false,
        ai_assistant: false,
        marketing_automation: false,
        custom_domain: false,
      },
    },
    {
      key: 'BUSINESS',
      name: uz('Biznes', 'Бизнес'),
      monthlyPrice: 349000,
      sortOrder: 2,
      features: {
        orders_per_month: 3000,
        products: 2000,
        employees: 20,
        branches: 5,
        advanced_analytics: true,
        ai_assistant: false,
        marketing_automation: true,
        custom_domain: false,
      },
    },
    {
      key: 'PRO',
      name: uz('Pro', 'Про'),
      monthlyPrice: 749000,
      sortOrder: 3,
      features: {
        orders_per_month: null,
        products: null,
        employees: 100,
        branches: 20,
        advanced_analytics: true,
        ai_assistant: true,
        marketing_automation: true,
        custom_domain: true,
      },
    },
    {
      key: 'ENTERPRISE',
      name: uz('Korxona', 'Корпоративный'),
      monthlyPrice: 0,
      sortOrder: 4,
      isPublic: false,
      features: {
        orders_per_month: null,
        products: null,
        employees: null,
        branches: null,
        advanced_analytics: true,
        ai_assistant: true,
        marketing_automation: true,
        custom_domain: true,
      },
    },
  ];

  for (const plan of plans) {
    const { features, ...rest } = plan;
    const created = await prisma.plan.upsert({
      where: { key: plan.key },
      update: { name: rest.name, monthlyPrice: rest.monthlyPrice, sortOrder: rest.sortOrder },
      create: { ...rest, yearlyPrice: rest.monthlyPrice * 10, currency: 'UZS' },
    });
    for (const [key, value] of Object.entries(features)) {
      await prisma.planFeature.upsert({
        where: { planId_key: { planId: created.id, key } },
        update: { enabled: value !== false, limit: typeof value === 'number' ? value : null },
        create: {
          planId: created.id,
          key,
          enabled: value !== false,
          limit: typeof value === 'number' ? value : null,
        },
      });
    }
  }
  console.log(`  ✓ ${plans.length} plans`);
}

async function seedTemplates() {
  for (const def of Object.values(TEMPLATE_DEFINITIONS)) {
    await prisma.businessTemplate.upsert({
      where: { key: def.key },
      update: {
        name: def.label,
        description: def.description,
        icon: def.icon,
        modules: def.modules as unknown as Prisma.InputJsonValue,
        moduleConfig: def.moduleConfig as Prisma.InputJsonValue,
        miniAppTabs: def.miniAppTabs as unknown as Prisma.InputJsonValue,
        orderPipeline: def.orderPipeline as unknown as Prisma.InputJsonValue,
        seedContent: def.seed as unknown as Prisma.InputJsonValue,
      },
      create: {
        key: def.key,
        name: def.label,
        description: def.description,
        icon: def.icon,
        modules: def.modules as unknown as Prisma.InputJsonValue,
        moduleConfig: def.moduleConfig as Prisma.InputJsonValue,
        miniAppTabs: def.miniAppTabs as unknown as Prisma.InputJsonValue,
        orderPipeline: def.orderPipeline as unknown as Prisma.InputJsonValue,
        seedContent: def.seed as unknown as Prisma.InputJsonValue,
      },
    });
  }
  console.log(`  ✓ ${Object.keys(TEMPLATE_DEFINITIONS).length} business templates`);
}

async function seedFeatureFlags() {
  const flags = [
    { key: 'AI_ASSISTANT', description: 'AI-powered customer assistant', enabled: false },
    { key: 'ADVANCED_ANALYTICS', description: 'Cohorts, retention, LTV, RFM', enabled: false },
    {
      key: 'MARKETING_AUTOMATION',
      description: 'Campaigns and automated journeys',
      enabled: false,
    },
    { key: 'POS_BETA', description: 'Point of sale beta', enabled: false },
    {
      key: 'NEW_MINIAPP',
      description: 'Next-generation Mini App shell',
      enabled: false,
      rolloutPercent: 10,
    },
    { key: 'REALTIME_ORDERS', description: 'Live order board via websockets', enabled: true },
  ];
  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { description: flag.description },
      create: flag,
    });
  }
  console.log(`  ✓ ${flags.length} feature flags`);
}

// ── tenant scaffolding ─────────────────────────────────────────────────────────

interface TenantSpec {
  slug: string;
  name: string;
  templateKey: BusinessTemplateKey;
  primaryColor: string;
  ownerEmail: string;
  ownerFirstName: string;
  phone: string;
  description: { uz: string; ru?: string };
  workingHours: Record<string, { start: string; end: string }[]>;
  loyaltyRate: number;
}

async function createTenant(spec: TenantSpec) {
  // Re-seeding replaces the demo tenant, and deleting a tenant cascades into its audit
  // log — which the append-only trigger blocks unless the transaction opts in. Same
  // mechanism as TenantsService.purge(); without it the seed works exactly once, on an
  // empty database, and fails on every refresh afterwards.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL bizbot.allow_audit_purge = 'on'`;
    await tx.tenant.deleteMany({ where: { slug: spec.slug } });
  });

  const tenant = await prisma.tenant.create({
    data: {
      slug: spec.slug,
      name: spec.name,
      templateKey: spec.templateKey,
      status: 'ACTIVE',
      primaryColor: spec.primaryColor,
      timezone: 'Asia/Tashkent',
      currency: 'UZS',
      defaultLanguage: 'uz',
      isDemo: true,
      onboardingStep: 8,
      onboardingCompletedAt: daysAgo(60),
    },
  });

  const template = TEMPLATE_DEFINITIONS[spec.templateKey];
  const modules = withDependencies(template.modules);
  await prisma.tenantModule.createMany({
    data: modules.map((module) => ({
      tenantId: tenant.id,
      module,
      enabled: true,
      config: (template.moduleConfig[module] ?? {}) as Prisma.InputJsonValue,
    })),
  });

  await prisma.tenantSettings.create({
    data: {
      tenantId: tenant.id,
      phone: spec.phone,
      description: spec.description,
      workingHours: spec.workingHours as Prisma.InputJsonValue,
      deliverySettings: {
        enabled: modules.includes('DELIVERY'),
        flatFee: 15000,
        freeAbove: 200000,
        minOrderTotal: 50000,
        estimatedMinutes: 45,
      },
      bookingSettings: {
        slotStepMinutes: 15,
        minLeadTimeMinutes: 60,
        maxAdvanceDays: 30,
        autoConfirm: true,
        requirePrepayment: false,
        cancellationDeadlineMinutes: 120,
        reminderOffsetsMinutes: [1440, 120],
      },
      loyaltySettings: {
        enabled: true,
        type: 'CASHBACK',
        rate: spec.loyaltyRate,
        minOrderTotal: 0,
        maxRedeemPercent: 50,
        expiryDays: null,
      },
    },
  });

  // Owner account. One person may own several businesses, so the user is reused when the
  // same email appears again.
  const passwordHash = await seedPasswordHash(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: spec.ownerEmail },
    // Re-seeding resets the demo credentials. With `update: {}` an account created by an
    // earlier seed kept its old hash, so the documented demo password stopped working —
    // exactly the thing a demo seed must never do.
    update: { passwordHash, isActive: true, lockedUntil: null, failedLoginAttempts: 0 },
    create: {
      email: spec.ownerEmail,
      passwordHash,
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: spec.ownerFirstName, language: 'uz', phone: spec.phone } },
    },
  });

  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' as MemberRole },
  });

  const plan = await prisma.plan.findUniqueOrThrow({ where: { key: 'BUSINESS' } });
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'ACTIVE',
      currentPeriodStart: daysAgo(15),
      currentPeriodEnd: daysAhead(15),
    },
  });

  // System segments — stored filters, so a tenant can edit or add their own later.
  await prisma.customerSegment.createMany({
    data: [
      {
        tenantId: tenant.id,
        key: 'new_customers',
        isSystem: true,
        name: uz('Yangi mijozlar', 'Новые клиенты'),
        filter: { all: [{ field: 'orderCount', op: 'lte', value: 1 }] },
      },
      {
        tenantId: tenant.id,
        key: 'repeat_customers',
        isSystem: true,
        name: uz('Qaytgan mijozlar', 'Повторные клиенты'),
        filter: { all: [{ field: 'orderCount', op: 'gte', value: 2 }] },
      },
      {
        tenantId: tenant.id,
        key: 'vip',
        isSystem: true,
        name: uz('VIP mijozlar', 'VIP-клиенты'),
        filter: { all: [{ field: 'totalSpent', op: 'gte', value: 1000000 }] },
      },
      {
        tenantId: tenant.id,
        key: 'inactive_30d',
        isSystem: true,
        name: uz('30 kun faol emas', 'Неактивны 30 дней'),
        filter: { all: [{ field: 'lastActivityAt', op: 'daysAgoGt', value: 30 }] },
      },
      {
        tenantId: tenant.id,
        key: 'birthday_today',
        isSystem: true,
        name: uz('Bugun tug‘ilgan kun', 'День рождения сегодня'),
        filter: { all: [{ field: 'birthDate', op: 'monthDayEq', value: 'today' }] },
      },
    ],
  });

  return { tenant, user };
}

export {
  prisma,
  createTenant,
  seedPlans,
  seedTemplates,
  seedFeatureFlags,
  uz,
  daysAgo,
  daysAhead,
  FULL_WEEK_HOURS,
  WORKDAY_HOURS,
  DEMO_PASSWORD,
  randomCode,
  formatOrderNumber,
};

// ── ANOR CAFE — restaurant ─────────────────────────────────────────────────────

async function seedAnorCafe() {
  const { tenant } = await createTenant({
    slug: 'anor-cafe',
    name: 'Anor Cafe',
    templateKey: 'RESTAURANT',
    primaryColor: '#C2410C',
    ownerEmail: 'anor@bizbot.uz',
    ownerFirstName: 'Bobur',
    phone: '998901234567',
    description: uz(
      'Toshkentdagi milliy va yevropa taomlari restorani. Yetkazib berish 45 daqiqada.',
      'Ресторан национальной и европейской кухни в Ташкенте. Доставка за 45 минут.',
    ),
    workingHours: FULL_WEEK_HOURS,
    loyaltyRate: 5,
  });
  const tenantId = tenant.id;

  const branches = await Promise.all([
    prisma.branch.create({
      data: {
        tenantId,
        name: 'Chilonzor filiali',
        address: "Chilonzor tumani, Bunyodkor ko'chasi 12",
        phone: '998901234567',
        latitude: 41.2856,
        longitude: 69.2034,
        workingHours: FULL_WEEK_HOURS as Prisma.InputJsonValue,
        isDefault: true,
      },
    }),
    prisma.branch.create({
      data: {
        tenantId,
        name: 'Yunusobod filiali',
        address: "Yunusobod tumani, Amir Temur ko'chasi 108",
        phone: '998901234568',
        latitude: 41.3421,
        longitude: 69.2876,
        workingHours: FULL_WEEK_HOURS as Prisma.InputJsonValue,
      },
    }),
  ]);

  const categories = await Promise.all(
    [
      uz('Milliy taomlar', 'Национальные блюда'),
      uz('Fast food', 'Фастфуд'),
      uz('Salatlar', 'Салаты'),
      uz('Ichimliklar', 'Напитки'),
      uz('Shirinliklar', 'Десерты'),
    ].map((name, i) => prisma.category.create({ data: { tenantId, name, sortOrder: i } })),
  );

  const sizeGroup = await prisma.modifierGroup.create({
    data: {
      tenantId,
      name: uz('Hajmi', 'Размер'),
      minSelect: 1,
      maxSelect: 1,
      sortOrder: 0,
      options: {
        create: [
          { tenantId, name: uz('Kichik', 'Маленький'), price: 0, isDefault: true, sortOrder: 0 },
          { tenantId, name: uz('O‘rta', 'Средний'), price: 8000, sortOrder: 1 },
          { tenantId, name: uz('Katta', 'Большой'), price: 15000, sortOrder: 2 },
        ],
      },
    },
    include: { options: true },
  });

  const extrasGroup = await prisma.modifierGroup.create({
    data: {
      tenantId,
      name: uz('Qo‘shimchalar', 'Добавки'),
      minSelect: 0,
      maxSelect: 5,
      sortOrder: 1,
      options: {
        create: [
          {
            tenantId,
            name: uz('Qo‘shimcha pishloq', 'Дополнительный сыр'),
            price: 8000,
            sortOrder: 0,
          },
          {
            tenantId,
            name: uz('Qo‘shimcha go‘sht', 'Дополнительное мясо'),
            price: 15000,
            sortOrder: 1,
          },
          { tenantId, name: uz('Achchiq sous', 'Острый соус'), price: 3000, sortOrder: 2 },
          { tenantId, name: uz('Piyozsiz', 'Без лука'), price: 0, sortOrder: 3 },
        ],
      },
    },
    include: { options: true },
  });

  const menu: {
    name: { uz: string; ru?: string };
    price: number;
    categoryIdx: number;
    featured?: boolean;
    groups?: string[];
    oldPrice?: number;
  }[] = [
    {
      name: uz('Osh', 'Плов'),
      price: 35000,
      categoryIdx: 0,
      featured: true,
      groups: [extrasGroup.id],
    },
    { name: uz('Lag‘mon', 'Лагман'), price: 32000, categoryIdx: 0, groups: [extrasGroup.id] },
    { name: uz('Manti (6 dona)', 'Манты (6 шт)'), price: 38000, categoryIdx: 0 },
    { name: uz('Somsa', 'Самса'), price: 12000, categoryIdx: 0 },
    {
      name: uz('Shashlik (qo‘y)', 'Шашлык (баранина)'),
      price: 42000,
      categoryIdx: 0,
      groups: [extrasGroup.id],
    },
    {
      name: uz('Burger', 'Бургер'),
      price: 45000,
      categoryIdx: 1,
      featured: true,
      groups: [sizeGroup.id, extrasGroup.id],
    },
    {
      name: uz('Pepperoni pizza', 'Пицца Пепперони'),
      price: 69000,
      categoryIdx: 1,
      featured: true,
      oldPrice: 79000,
      groups: [sizeGroup.id, extrasGroup.id],
    },
    {
      name: uz('Margarita pizza', 'Пицца Маргарита'),
      price: 59000,
      categoryIdx: 1,
      groups: [sizeGroup.id, extrasGroup.id],
    },
    { name: uz('Hot-dog', 'Хот-дог'), price: 22000, categoryIdx: 1, groups: [extrasGroup.id] },
    { name: uz('Sezar salati', 'Салат Цезарь'), price: 38000, categoryIdx: 2 },
    { name: uz('Achchiq-chuchuk', 'Ачик-чучук'), price: 18000, categoryIdx: 2 },
    {
      name: uz('Cappuccino', 'Капучино'),
      price: 25000,
      categoryIdx: 3,
      featured: true,
      groups: [sizeGroup.id],
    },
    { name: uz('Amerikano', 'Американо'), price: 20000, categoryIdx: 3, groups: [sizeGroup.id] },
    { name: uz('Ko‘k choy', 'Зелёный чай'), price: 10000, categoryIdx: 3 },
    { name: uz('Ayron', 'Айран'), price: 12000, categoryIdx: 3 },
    { name: uz('Tiramisu', 'Тирамису'), price: 34000, categoryIdx: 4 },
    { name: uz('Cheesecake', 'Чизкейк'), price: 36000, categoryIdx: 4 },
  ];

  const products = [];
  for (const [i, item] of menu.entries()) {
    products.push(
      await prisma.product.create({
        data: {
          tenantId,
          categoryId: categories[item.categoryIdx]!.id,
          name: item.name,
          price: item.price,
          oldPrice: item.oldPrice ?? null,
          costPrice: Math.round(item.price * 0.45),
          sku: `ANOR-${String(i + 1).padStart(3, '0')}`,
          isFeatured: item.featured ?? false,
          trackInventory: item.categoryIdx === 3,
          stockQuantity: item.categoryIdx === 3 ? 120 : 0,
          lowStockThreshold: item.categoryIdx === 3 ? 20 : null,
          sortOrder: i,
          modifierGroups: item.groups
            ? { create: item.groups.map((groupId, gi) => ({ tenantId, groupId, sortOrder: gi })) }
            : undefined,
        },
      }),
    );
  }

  await prisma.promoCode.createMany({
    data: [
      {
        tenantId,
        code: 'ANOR10',
        type: 'PERCENTAGE',
        value: 10,
        minOrderTotal: 100000,
        maxDiscount: 30000,
        usageLimit: 500,
        perCustomerLimit: 2,
        endsAt: daysAhead(45),
      },
      {
        tenantId,
        code: 'YANGI15',
        type: 'PERCENTAGE',
        value: 15,
        minOrderTotal: 80000,
        maxDiscount: 25000,
        perCustomerLimit: 1,
        endsAt: daysAhead(90),
      },
      {
        tenantId,
        code: 'OSH20000',
        type: 'FIXED',
        value: 20000,
        minOrderTotal: 150000,
        usageLimit: 200,
        endsAt: daysAhead(30),
      },
    ],
  });

  const customerSpecs = [
    { firstName: 'Aziz', lastName: 'Karimov', phone: '998901112233', tgId: 501111111n },
    { firstName: 'Dilnoza', lastName: 'Rahimova', phone: '998902223344', tgId: 502222222n },
    { firstName: 'Jasur', lastName: 'Toshmatov', phone: '998903334455', tgId: 503333333n },
    {
      firstName: 'Malika',
      lastName: 'Yusupova',
      phone: '998904445566',
      tgId: 504444444n,
      language: 'ru',
    },
    { firstName: 'Sanjar', lastName: 'Ibragimov', phone: '998905556677', tgId: 505555555n },
    { firstName: 'Nilufar', lastName: 'Saidova', phone: '998906667788', tgId: 506666666n },
    { firstName: 'Otabek', lastName: 'Nazarov', phone: '998907778899', tgId: 507777777n },
    {
      firstName: 'Zarina',
      lastName: 'Umarova',
      phone: '998908889900',
      tgId: 508888888n,
      language: 'ru',
    },
  ];

  const customers = [];
  for (const [i, spec] of customerSpecs.entries()) {
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        telegramUserId: spec.tgId,
        telegramUsername: `${spec.firstName.toLowerCase()}_uz`,
        firstName: spec.firstName,
        lastName: spec.lastName,
        phone: spec.phone,
        language: spec.language ?? 'uz',
        source: 'TELEGRAM',
        lastActivityAt: daysAgo(i),
        createdAt: daysAgo(60 - i * 5),
        addresses: {
          create: [
            {
              tenantId,
              label: 'Uy',
              line1: `Toshkent, ${['Chilonzor', 'Yunusobod', 'Mirzo Ulug‘bek', 'Yakkasaroy'][i % 4]} tumani, ${10 + i}-uy`,
              isDefault: true,
            },
          ],
        },
        loyaltyAccount: { create: { tenantId, balance: 0 } },
      },
      include: { addresses: true, loyaltyAccount: true },
    });
    customers.push(customer);
  }

  await seedOrderHistory(
    tenantId,
    customers,
    products,
    branches.map((b) => b.id),
    5,
  );
  console.log('  ✓ Anor Cafe — 17 menu items, 2 branches, 8 customers, order history');
  return tenant;
}

// ── order history ──────────────────────────────────────────────────────────────

/**
 * Generates believable order history: a spread of statuses and dates, loyalty credited
 * through the ledger (never by writing a balance directly), and totals that satisfy the
 * database CHECK constraints — the same rules the real checkout path must satisfy.
 */
async function seedOrderHistory(
  tenantId: string,
  customers: { id: string; addresses: { id: string }[]; phone: string | null }[],
  products: { id: string; name: Prisma.JsonValue; price: number; sku: string | null }[],
  branchIds: string[],
  loyaltyRate: number,
) {
  const statuses = [
    'COMPLETED',
    'COMPLETED',
    'COMPLETED',
    'COMPLETED',
    'DELIVERING',
    'PREPARING',
    'ACCEPTED',
    'NEW',
    'CANCELLED',
  ] as const;
  const methods = ['CASH', 'CLICK', 'PAYME', 'CASH', 'CLICK'] as const;
  const daySequences = new Map<string, number>();

  for (let i = 0; i < 28; i++) {
    const customer = customers[i % customers.length]!;
    const status = statuses[i % statuses.length]!;
    const method = methods[i % methods.length]!;
    const createdAt = daysAgo(Math.floor(i / 1.4), 11 + (i % 9));
    const dayKey = createdAt.toISOString().slice(0, 10);
    const sequence = (daySequences.get(dayKey) ?? 0) + 1;
    daySequences.set(dayKey, sequence);

    // 1–3 line items
    const lineCount = 1 + (i % 3);
    const lines = Array.from({ length: lineCount }, (_, k) => {
      const product = products[(i * 3 + k) % products.length]!;
      const quantity = 1 + ((i + k) % 3);
      return { product, quantity, unitPrice: product.price, modifiersPrice: 0 };
    });

    const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    const fulfillmentType = i % 3 === 0 ? 'PICKUP' : 'DELIVERY';
    const deliveryFee = fulfillmentType === 'DELIVERY' && subtotal < 200000 ? 15000 : 0;
    const promoDiscount = i % 5 === 0 ? Math.min(30000, Math.round(subtotal * 0.1)) : 0;
    const discountTotal = promoDiscount;
    const total = subtotal - discountTotal + deliveryFee;
    // Spread the order discount across the lines exactly as checkout does
    // (apps/api/src/modules/cart/pricing.service.ts). Leaving the lines at full price
    // while the header claims a discount produces data the application itself would
    // never write, and a per-line refund against it would refund more than was charged.
    const lineDiscounts = distributeProportionally(
      discountTotal,
      lines.map((l) => (l.unitPrice + l.modifiersPrice) * l.quantity),
    );
    const isPaid = status === 'COMPLETED' || (status === 'DELIVERING' && method !== 'CASH');
    const loyaltyEarned = status === 'COMPLETED' ? Math.round((total * loyaltyRate) / 100) : 0;

    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: formatOrderNumber(createdAt, sequence),
        customerId: customer.id,
        branchId: branchIds[i % branchIds.length]!,
        addressId: fulfillmentType === 'DELIVERY' ? (customer.addresses[0]?.id ?? null) : null,
        status,
        fulfillmentType,
        paymentStatus: isPaid ? 'PAID' : status === 'CANCELLED' ? 'UNPAID' : 'UNPAID',
        paymentMethod: method,
        subtotal,
        discountTotal,
        promoDiscount,
        deliveryFee,
        total,
        loyaltyEarned,
        phoneSnapshot: customer.phone,
        source: i % 4 === 0 ? 'BOT' : 'MINIAPP',
        createdAt,
        updatedAt: createdAt,
        acceptedAt:
          status !== 'NEW' && status !== 'CANCELLED'
            ? new Date(createdAt.getTime() + 5 * 60000)
            : null,
        completedAt: status === 'COMPLETED' ? new Date(createdAt.getTime() + 45 * 60000) : null,
        cancelledAt: status === 'CANCELLED' ? new Date(createdAt.getTime() + 10 * 60000) : null,
        cancelReason: status === 'CANCELLED' ? 'Mijoz bekor qildi' : null,
        items: {
          create: lines.map((l, k) => ({
            tenantId,
            productId: l.product.id,
            nameSnapshot: l.product.name as Prisma.InputJsonValue,
            skuSnapshot: l.product.sku,
            unitPrice: l.unitPrice,
            modifiersPrice: l.modifiersPrice,
            quantity: l.quantity,
            discount: lineDiscounts[k] ?? 0,
            total: (l.unitPrice + l.modifiersPrice) * l.quantity - (lineDiscounts[k] ?? 0),
          })),
        },
        statusHistory: {
          create: { tenantId, toStatus: status, createdAt, comment: 'Seed data' },
        },
      },
    });

    if (isPaid) {
      await prisma.payment.create({
        data: {
          tenantId,
          orderId: order.id,
          customerId: customer.id,
          provider: method.toLowerCase(),
          method,
          state: 'PAID',
          amount: total,
          externalId: method === 'CASH' ? null : `demo-${order.id.slice(0, 8)}`,
          paidAt: new Date(createdAt.getTime() + 2 * 60000),
          createdAt,
        },
      });
    }

    // Loyalty is credited through the ledger, and the cached balance is written in the
    // same transaction — invariant I5, exactly as the real accrual handler must do it.
    if (loyaltyEarned > 0) {
      await prisma.$transaction(async (tx) => {
        const account = await tx.loyaltyAccount.findUniqueOrThrow({
          where: { customerId: customer.id },
        });
        const balanceAfter = account.balance + loyaltyEarned;
        await tx.loyaltyTransaction.create({
          data: {
            tenantId,
            accountId: account.id,
            orderId: order.id,
            type: 'EARN',
            amount: loyaltyEarned,
            balanceAfter,
            reason: `Buyurtma ${order.orderNumber} uchun keshbek`,
            createdAt,
          },
        });
        await tx.loyaltyAccount.update({
          where: { id: account.id },
          data: {
            balance: balanceAfter,
            lifetimeEarned: { increment: BigInt(loyaltyEarned) },
          },
        });
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            loyaltyBalance: balanceAfter,
            totalSpent: { increment: BigInt(total) },
            orderCount: { increment: 1 },
          },
        });
      });
    }

    await prisma.customerTimelineEntry.create({
      data: {
        tenantId,
        customerId: customer.id,
        type: 'ORDER_CREATED',
        title: uz(`Buyurtma ${order.orderNumber}`, `Заказ ${order.orderNumber}`),
        amount: total,
        entityType: 'ORDER',
        entityId: order.id,
        occurredAt: createdAt,
      },
    });
  }

  // Record where each day's numbering reached. Without this the sequence table starts at
  // zero and the first real order after seeding collides with a seeded order number —
  // a demo environment that breaks the moment someone actually uses it.
  for (const [dayKey, value] of daySequences) {
    const day = new Date(`${dayKey}T00:00:00Z`);
    await prisma.orderSequence.upsert({
      where: { tenantId_day: { tenantId, day } },
      create: { tenantId, day, value },
      update: { value },
    });
  }
}

// ── BARBER HOUSE — barbershop ──────────────────────────────────────────────────

async function seedBarberHouse() {
  const { tenant } = await createTenant({
    slug: 'barber-house',
    name: 'Barber House',
    templateKey: 'BEAUTY',
    primaryColor: '#1F2937',
    ownerEmail: 'barber@bizbot.uz',
    ownerFirstName: 'Jamshid',
    phone: '998911234567',
    description: uz(
      'Erkaklar uchun zamonaviy barbershop. Onlayn navbatga yozilish.',
      'Современный барбершоп для мужчин. Онлайн-запись.',
    ),
    workingHours: WORKDAY_HOURS,
    loyaltyRate: 5,
  });
  const tenantId = tenant.id;

  const branch = await prisma.branch.create({
    data: {
      tenantId,
      name: 'Barber House — Mirobod',
      address: "Mirobod tumani, Shota Rustaveli ko'chasi 45",
      phone: '998911234567',
      latitude: 41.2995,
      longitude: 69.2401,
      isDefault: true,
      workingHours: WORKDAY_HOURS as Prisma.InputJsonValue,
    },
  });

  const categories = await Promise.all(
    [uz('Soch', 'Волосы'), uz('Soqol', 'Борода'), uz('Kompleks', 'Комплекс')].map((name, i) =>
      prisma.category.create({ data: { tenantId, name, sortOrder: i } }),
    ),
  );

  const services = await Promise.all([
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[0]!.id,
        name: uz('Soch olish', 'Стрижка'),
        price: 100000,
        durationMinutes: 45,
        bufferAfterMinutes: 10,
        sortOrder: 0,
        description: uz('Mashinka va qaychi bilan zamonaviy soch turmagi'),
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[1]!.id,
        name: uz('Soqol olish', 'Бритьё бороды'),
        price: 60000,
        durationMinutes: 30,
        bufferAfterMinutes: 10,
        sortOrder: 1,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[2]!.id,
        name: uz('Soch + soqol', 'Стрижка + борода'),
        price: 140000,
        durationMinutes: 75,
        bufferAfterMinutes: 15,
        sortOrder: 2,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[0]!.id,
        name: uz('Bolalar sochi', 'Детская стрижка'),
        price: 70000,
        durationMinutes: 30,
        sortOrder: 3,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[1]!.id,
        name: uz('Qirqish (royal shave)', 'Королевское бритьё'),
        price: 90000,
        durationMinutes: 45,
        sortOrder: 4,
      },
    }),
  ]);

  const masters = [
    {
      firstName: 'Jamshid',
      lastName: 'Qodirov',
      position: 'Bosh usta',
      serviceIdx: [0, 1, 2, 3, 4],
    },
    { firstName: 'Sardor', lastName: 'Aliyev', position: 'Usta', serviceIdx: [0, 1, 2, 3] },
    { firstName: 'Alisher', lastName: 'Ergashev', position: 'Usta', serviceIdx: [0, 2, 3] },
  ];

  const resources = [];
  for (const [i, master] of masters.entries()) {
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        branchId: branch.id,
        firstName: master.firstName,
        lastName: master.lastName,
        position: master.position,
        phone: `99891123456${i + 1}`,
        sortOrder: i,
        services: {
          create: master.serviceIdx.map((si) => ({ tenantId, serviceId: services[si]!.id })),
        },
      },
    });

    // Creating an employee auto-creates their bookable resource, so a salon owner never
    // has to learn the word "resource" (docs/adr/0007-resource-based-booking.md).
    const resource = await prisma.bookingResource.create({
      data: {
        tenantId,
        branchId: branch.id,
        employeeId: employee.id,
        name: `${master.firstName} ${master.lastName}`,
        kind: 'EMPLOYEE',
        bufferAfterMinutes: 10,
        schedules: {
          create: [1, 2, 3, 4, 5, 6].map((weekday) => ({
            tenantId,
            weekday,
            startTime: i === 2 ? '12:00' : '10:00',
            endTime: i === 2 ? '20:00' : '19:00',
          })),
        },
      },
    });
    resources.push(resource);
  }

  // One master takes a day off, so availability has something real to exclude.
  await prisma.resourceTimeOff.create({
    data: {
      tenantId,
      resourceId: resources[1]!.id,
      startsAt: daysAhead(3, 0),
      endsAt: daysAhead(4, 0),
      reason: 'Dam olish kuni',
    },
  });

  const clientSpecs = [
    { firstName: 'Ravshan', lastName: 'Mirzayev', phone: '998931112233', tgId: 601111111n },
    { firstName: 'Bekzod', lastName: 'Xolmatov', phone: '998932223344', tgId: 602222222n },
    { firstName: 'Shohruh', lastName: 'Ismoilov', phone: '998933334455', tgId: 603333333n },
    { firstName: 'Timur', lastName: 'Abdullayev', phone: '998934445566', tgId: 604444444n },
    { firstName: 'Doniyor', lastName: 'Rasulov', phone: '998935556677', tgId: 605555555n },
    { firstName: 'Akmal', lastName: 'Jo‘rayev', phone: '998936667788', tgId: 606666666n },
  ];

  const clients = [];
  for (const [i, spec] of clientSpecs.entries()) {
    clients.push(
      await prisma.customer.create({
        data: {
          tenantId,
          telegramUserId: spec.tgId,
          telegramUsername: `${spec.firstName.toLowerCase()}_uz`,
          firstName: spec.firstName,
          lastName: spec.lastName,
          phone: spec.phone,
          source: 'TELEGRAM',
          lastActivityAt: daysAgo(i),
          createdAt: daysAgo(45 - i * 4),
          loyaltyAccount: { create: { tenantId, balance: 0 } },
        },
      }),
    );
  }

  await seedBookingHistory(tenantId, clients, services, resources, branch.id);
  console.log('  ✓ Barber House — 5 services, 3 masters with schedules, 6 clients, bookings');
  return tenant;
}

// ── booking history ────────────────────────────────────────────────────────────

/**
 * Past and upcoming appointments. Slots are laid out so no two bookings for one resource
 * overlap — the `booking_no_overlap` exclusion constraint would reject them otherwise,
 * which makes this seed a live check that the constraint and the data model agree.
 */
async function seedBookingHistory(
  tenantId: string,
  clients: { id: string }[],
  services: {
    id: string;
    name: Prisma.JsonValue;
    price: number;
    durationMinutes: number;
    bufferAfterMinutes: number;
  }[],
  resources: { id: string; bufferBeforeMinutes: number; bufferAfterMinutes: number }[],
  branchId: string,
) {
  // Per resource, walk a cursor forward through working hours so slots never collide.
  const cursors = new Map<string, number>();
  let counter = 0;

  const plan: {
    dayOffset: number;
    status: 'COMPLETED' | 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'NO_SHOW';
  }[] = [
    { dayOffset: -14, status: 'COMPLETED' },
    { dayOffset: -12, status: 'COMPLETED' },
    { dayOffset: -10, status: 'COMPLETED' },
    { dayOffset: -9, status: 'NO_SHOW' },
    { dayOffset: -7, status: 'COMPLETED' },
    { dayOffset: -5, status: 'COMPLETED' },
    { dayOffset: -4, status: 'CANCELLED' },
    { dayOffset: -3, status: 'COMPLETED' },
    { dayOffset: -2, status: 'COMPLETED' },
    { dayOffset: -1, status: 'COMPLETED' },
    { dayOffset: 1, status: 'CONFIRMED' },
    { dayOffset: 1, status: 'CONFIRMED' },
    { dayOffset: 2, status: 'CONFIRMED' },
    { dayOffset: 2, status: 'PENDING' },
    { dayOffset: 4, status: 'CONFIRMED' },
    { dayOffset: 5, status: 'CONFIRMED' },
    { dayOffset: 6, status: 'PENDING' },
  ];

  for (const [i, entry] of plan.entries()) {
    const resource = resources[i % resources.length]!;
    const service = services[i % services.length]!;
    const client = clients[i % clients.length]!;

    const cursorKey = `${resource.id}:${entry.dayOffset}`;
    const startMinuteLocal = cursors.get(cursorKey) ?? 10 * 60;
    const blockMinutes =
      resource.bufferBeforeMinutes +
      service.durationMinutes +
      Math.max(service.bufferAfterMinutes, resource.bufferAfterMinutes);
    cursors.set(cursorKey, startMinuteLocal + blockMinutes + 15);

    const startsAt = daysAhead(
      entry.dayOffset,
      Math.floor(startMinuteLocal / 60),
      startMinuteLocal % 60,
    );
    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60000);
    const blockStartsAt = new Date(startsAt.getTime() - resource.bufferBeforeMinutes * 60000);
    const blockEndsAt = new Date(
      endsAt.getTime() + Math.max(service.bufferAfterMinutes, resource.bufferAfterMinutes) * 60000,
    );

    counter++;
    const booking = await prisma.booking.create({
      data: {
        tenantId,
        bookingNumber: `B-${String(counter).padStart(4, '0')}`,
        customerId: client.id,
        serviceId: service.id,
        resourceId: resource.id,
        branchId,
        status: entry.status,
        startsAt,
        endsAt,
        blockStartsAt,
        blockEndsAt,
        durationMinutes: service.durationMinutes,
        priceSnapshot: service.price,
        serviceNameSnapshot: service.name as Prisma.InputJsonValue,
        paymentStatus: entry.status === 'COMPLETED' ? 'PAID' : 'UNPAID',
        source: i % 3 === 0 ? 'BOT' : 'MINIAPP',
        createdAt: daysAgo(Math.max(1, Math.abs(entry.dayOffset) + 1)),
        confirmedAt:
          entry.status !== 'PENDING' && entry.status !== 'CANCELLED'
            ? daysAgo(Math.abs(entry.dayOffset) + 1)
            : null,
        completedAt: entry.status === 'COMPLETED' ? endsAt : null,
        cancelledAt: entry.status === 'CANCELLED' ? daysAgo(Math.abs(entry.dayOffset) + 1) : null,
        statusHistory: { create: { tenantId, toStatus: entry.status, comment: 'Seed data' } },
      },
    });

    if (entry.status === 'COMPLETED') {
      await prisma.$transaction(async (tx) => {
        const account = await tx.loyaltyAccount.findUniqueOrThrow({
          where: { customerId: client.id },
        });
        const earned = Math.round(service.price * 0.05);
        const balanceAfter = account.balance + earned;
        await tx.loyaltyTransaction.create({
          data: {
            tenantId,
            accountId: account.id,
            type: 'EARN',
            amount: earned,
            balanceAfter,
            reason: `Bron ${booking.bookingNumber} uchun keshbek`,
          },
        });
        await tx.loyaltyAccount.update({
          where: { id: account.id },
          data: { balance: balanceAfter, lifetimeEarned: { increment: BigInt(earned) } },
        });
        await tx.customer.update({
          where: { id: client.id },
          data: {
            loyaltyBalance: balanceAfter,
            totalSpent: { increment: BigInt(service.price) },
            bookingCount: { increment: 1 },
          },
        });
      });
    }

    await prisma.customerTimelineEntry.create({
      data: {
        tenantId,
        customerId: client.id,
        type: 'BOOKING_CREATED',
        title: uz(`Bron ${booking.bookingNumber}`, `Запись ${booking.bookingNumber}`),
        amount: service.price,
        entityType: 'BOOKING',
        entityId: booking.id,
        occurredAt: booking.createdAt,
      },
    });
  }
}

// ── ZEBO BEAUTY — beauty salon ─────────────────────────────────────────────────

async function seedZeboBeauty() {
  const { tenant } = await createTenant({
    slug: 'zebo-beauty',
    name: 'Zebo Beauty',
    templateKey: 'BEAUTY',
    primaryColor: '#DB2777',
    ownerEmail: 'zebo@bizbot.uz',
    ownerFirstName: 'Zebo',
    phone: '998971234567',
    description: uz(
      'Ayollar uchun go‘zallik saloni: manikyur, pedikyur, soch turmagi va parvarish.',
      'Салон красоты для женщин: маникюр, педикюр, причёски и уход.',
    ),
    workingHours: WORKDAY_HOURS,
    loyaltyRate: 7,
  });
  const tenantId = tenant.id;

  const branch = await prisma.branch.create({
    data: {
      tenantId,
      name: 'Zebo Beauty — Yakkasaroy',
      address: "Yakkasaroy tumani, Bobur ko'chasi 27",
      phone: '998971234567',
      latitude: 41.2789,
      longitude: 69.2512,
      isDefault: true,
      workingHours: WORKDAY_HOURS as Prisma.InputJsonValue,
    },
  });

  const categories = await Promise.all(
    [uz('Tirnoq', 'Ногти'), uz('Soch', 'Волосы'), uz('Yuz parvarishi', 'Уход за лицом')].map(
      (name, i) => prisma.category.create({ data: { tenantId, name, sortOrder: i } }),
    ),
  );

  const services = await Promise.all([
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[0]!.id,
        name: uz('Manikyur', 'Маникюр'),
        price: 120000,
        durationMinutes: 60,
        bufferAfterMinutes: 10,
        sortOrder: 0,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[0]!.id,
        name: uz('Pedikyur', 'Педикюр'),
        price: 150000,
        durationMinutes: 75,
        bufferAfterMinutes: 15,
        sortOrder: 1,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[1]!.id,
        name: uz('Soch turmagi', 'Причёска'),
        price: 180000,
        durationMinutes: 90,
        bufferAfterMinutes: 15,
        sortOrder: 2,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[1]!.id,
        name: uz('Soch bo‘yash', 'Окрашивание волос'),
        price: 350000,
        durationMinutes: 150,
        bufferAfterMinutes: 20,
        sortOrder: 3,
      },
    }),
    prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[2]!.id,
        name: uz('Yuz tozalash', 'Чистка лица'),
        price: 200000,
        durationMinutes: 60,
        sortOrder: 4,
      },
    }),
  ]);

  const mastersSpec = [
    {
      firstName: 'Zebo',
      lastName: 'Nazarova',
      position: 'Direktor / usta',
      serviceIdx: [0, 1, 2, 3, 4],
    },
    { firstName: 'Gulnora', lastName: 'Ahmedova', position: 'Manikyur ustasi', serviceIdx: [0, 1] },
    { firstName: 'Shahnoza', lastName: 'Tursunova', position: 'Stilist', serviceIdx: [2, 3] },
    { firstName: 'Kamola', lastName: 'Bekova', position: 'Kosmetolog', serviceIdx: [4] },
  ];

  const resources = [];
  for (const [i, master] of mastersSpec.entries()) {
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        branchId: branch.id,
        firstName: master.firstName,
        lastName: master.lastName,
        position: master.position,
        phone: `99897123456${i + 1}`,
        sortOrder: i,
        services: {
          create: master.serviceIdx.map((si) => ({ tenantId, serviceId: services[si]!.id })),
        },
      },
    });
    resources.push(
      await prisma.bookingResource.create({
        data: {
          tenantId,
          branchId: branch.id,
          employeeId: employee.id,
          name: `${master.firstName} ${master.lastName}`,
          kind: 'EMPLOYEE',
          bufferAfterMinutes: 10,
          schedules: {
            create: [1, 2, 3, 4, 5, 6].map((weekday) => ({
              tenantId,
              weekday,
              startTime: '10:00',
              endTime: '20:00',
            })),
          },
        },
      }),
    );
  }

  // A non-employee resource: the salon has one treatment room that any esthetician uses.
  // This is what the resource abstraction buys — no schema change to model it.
  await prisma.bookingResource.create({
    data: {
      tenantId,
      branchId: branch.id,
      name: 'Kosmetologiya xonasi',
      kind: 'ROOM',
      schedules: {
        create: [1, 2, 3, 4, 5, 6].map((weekday) => ({
          tenantId,
          weekday,
          startTime: '10:00',
          endTime: '20:00',
        })),
      },
    },
  });

  const clientSpecs = [
    { firstName: 'Nigora', lastName: 'Karimova', phone: '998941112233', tgId: 701111111n },
    {
      firstName: 'Sevara',
      lastName: 'Tosheva',
      phone: '998942223344',
      tgId: 702222222n,
      language: 'ru',
    },
    { firstName: 'Madina', lastName: 'Qosimova', phone: '998943334455', tgId: 703333333n },
    { firstName: 'Feruza', lastName: 'Sobirova', phone: '998944445566', tgId: 704444444n },
    { firstName: 'Lola', lastName: 'Aminova', phone: '998945556677', tgId: 705555555n },
    {
      firstName: 'Shirin',
      lastName: 'Valiyeva',
      phone: '998946667788',
      tgId: 706666666n,
      language: 'ru',
    },
  ];

  const clients = [];
  for (const [i, spec] of clientSpecs.entries()) {
    clients.push(
      await prisma.customer.create({
        data: {
          tenantId,
          telegramUserId: spec.tgId,
          telegramUsername: `${spec.firstName.toLowerCase()}_uz`,
          firstName: spec.firstName,
          lastName: spec.lastName,
          phone: spec.phone,
          language: spec.language ?? 'uz',
          source: 'TELEGRAM',
          birthDate: new Date(Date.UTC(1990 + i, i % 12, 5 + i)),
          lastActivityAt: daysAgo(i * 2),
          createdAt: daysAgo(50 - i * 3),
          loyaltyAccount: { create: { tenantId, balance: 0 } },
        },
      }),
    );
  }

  await prisma.promoCode.createMany({
    data: [
      {
        tenantId,
        code: 'ZEBO20',
        type: 'PERCENTAGE',
        value: 20,
        minOrderTotal: 200000,
        maxDiscount: 80000,
        perCustomerLimit: 1,
        endsAt: daysAhead(60),
      },
      {
        tenantId,
        code: 'DUGONA',
        type: 'FIXED',
        value: 50000,
        minOrderTotal: 150000,
        usageLimit: 100,
        endsAt: daysAhead(120),
      },
    ],
  });

  await seedBookingHistory(tenantId, clients, services, resources, branch.id);
  console.log('  ✓ Zebo Beauty — 5 services, 4 masters + 1 room resource, 6 clients, bookings');
  return tenant;
}

// ── notification templates ─────────────────────────────────────────────────────

async function seedNotificationTemplates(tenantIds: string[]) {
  const templates = [
    {
      key: 'ORDER_CREATED',
      body: uz(
        '✅ Buyurtmangiz qabul qilindi!\nRaqam: {{orderNumber}}\nSumma: {{total}}',
        '✅ Ваш заказ принят!\nНомер: {{orderNumber}}\nСумма: {{total}}',
      ),
    },
    {
      key: 'ORDER_ACCEPTED',
      body: uz(
        '👨‍🍳 {{orderNumber}} buyurtmangiz tayyorlanmoqda.',
        '👨‍🍳 Заказ {{orderNumber}} готовится.',
      ),
    },
    {
      key: 'ORDER_READY',
      body: uz('✅ {{orderNumber}} buyurtmangiz tayyor.', '✅ Ваш заказ {{orderNumber}} готов.'),
    },
    {
      key: 'ORDER_DELIVERING',
      body: uz('🚗 {{orderNumber}} buyurtmangiz yo‘lda.', '🚗 Заказ {{orderNumber}} в пути.'),
    },
    {
      key: 'ORDER_COMPLETED',
      body: uz('🙏 Buyurtmangiz yakunlandi. Rahmat!', '🙏 Заказ завершён. Спасибо!'),
    },
    {
      key: 'ORDER_CANCELLED',
      body: uz(
        '❌ {{orderNumber}} buyurtmangiz bekor qilindi.',
        '❌ Заказ {{orderNumber}} отменён.',
      ),
    },
    {
      key: 'BOOKING_CREATED',
      body: uz(
        '✅ Bron tasdiqlandi!\n{{service}}\n{{date}} {{time}}\n{{employee}}',
        '✅ Запись подтверждена!\n{{service}}\n{{date}} {{time}}\n{{employee}}',
      ),
    },
    {
      key: 'BOOKING_REMINDER',
      body: uz(
        '⏰ Eslatma: {{date}} soat {{time}} da {{service}} uchun bronigiz bor.',
        '⏰ Напоминание: {{date}} в {{time}} у вас запись на {{service}}.',
      ),
    },
    {
      key: 'BOOKING_CANCELLED',
      body: uz(
        '❌ {{date}} {{time}} dagi bron bekor qilindi.',
        '❌ Запись на {{date}} {{time}} отменена.',
      ),
    },
    {
      key: 'PAYMENT_SUCCESS',
      body: uz('💳 To‘lov qabul qilindi: {{amount}}', '💳 Оплата получена: {{amount}}'),
    },
    {
      key: 'LOYALTY_EARNED',
      body: uz(
        '⭐ Sizga {{amount}} bonus qo‘shildi. Umumiy: {{balance}}',
        '⭐ Вам начислено {{amount}} бонусов. Всего: {{balance}}',
      ),
    },
  ];

  for (const tenantId of tenantIds) {
    await prisma.notificationTemplate.createMany({
      data: templates.map((t) => ({
        tenantId,
        key: t.key,
        channel: 'TELEGRAM' as const,
        body: t.body,
      })),
      skipDuplicates: true,
    });
  }
  console.log(`  ✓ ${templates.length} notification templates × ${tenantIds.length} tenants`);
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱 Seeding BizBot OS\n');

  console.log('Platform:');
  await seedPlans();
  await seedTemplates();
  await seedFeatureFlags();

  console.log('\nDemo businesses:');
  const anor = await seedAnorCafe();
  const barber = await seedBarberHouse();
  const zebo = await seedZeboBeauty();

  console.log('');
  await seedNotificationTemplates([anor.id, barber.id, zebo.id]);

  console.log(`
✅ Seed complete.

   Demo logins (password: ${DEMO_PASSWORD})
     anor@bizbot.uz     Anor Cafe      restaurant, delivery, menu modifiers
     barber@bizbot.uz   Barber House   barbershop, 3 masters, online booking
     zebo@bizbot.uz     Zebo Beauty    beauty salon, 4 masters + a room resource

   No Telegram or payment credentials are required: demo tenants use the mock
   payment provider and the bot runs in polling mode.
`);
}

main()
  .catch((error) => {
    console.error('\n❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
