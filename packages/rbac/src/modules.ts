/**
 * Modules.
 *
 * A tenant enables modules; navigation, dashboard widgets, Mini App tabs, bot menu and
 * API access all derive from that. `@RequireModule` makes a disabled module genuinely
 * off rather than merely hidden.
 */

export const MODULES = [
  'CRM',
  'CATALOG',
  'SERVICES',
  'ORDERS',
  'BOOKING',
  'PAYMENTS',
  'DELIVERY',
  'BRANCHES',
  'EMPLOYEES',
  'INVENTORY',
  'LOYALTY',
  'PROMOCODES',
  'MARKETING',
  'MESSAGES',
  'ANALYTICS',
  'TELEGRAM',
  // declared, gated off in MVP
  'POS',
  'FINANCE',
  'SUPPLIERS',
  'AI',
  'AUTOMATION',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export interface ModuleDefinition {
  key: ModuleKey;
  label: { uz: string; ru: string };
  description: { uz: string; ru: string };
  /** Modules that must be enabled for this one to work. */
  requires: readonly ModuleKey[];
  /** Enabled for every tenant regardless of template; cannot be disabled. */
  core: boolean;
  /** Not yet shippable — visible in the roadmap, refused by the module service. */
  comingSoon: boolean;
  icon: string;
}

export const MODULE_DEFINITIONS: Record<ModuleKey, ModuleDefinition> = {
  CRM: {
    key: 'CRM',
    core: true,
    comingSoon: false,
    icon: 'users',
    requires: [],
    label: { uz: 'Mijozlar', ru: 'Клиенты' },
    description: {
      uz: 'Mijozlar bazasi, tarix va segmentlar',
      ru: 'База клиентов, история и сегменты',
    },
  },
  TELEGRAM: {
    key: 'TELEGRAM',
    core: true,
    comingSoon: false,
    icon: 'send',
    requires: [],
    label: { uz: 'Telegram', ru: 'Telegram' },
    description: { uz: 'Bot va Mini App', ru: 'Бот и Mini App' },
  },
  ANALYTICS: {
    key: 'ANALYTICS',
    core: true,
    comingSoon: false,
    icon: 'bar-chart',
    requires: [],
    label: { uz: 'Analitika', ru: 'Аналитика' },
    description: { uz: 'Savdo va mijozlar statistikasi', ru: 'Статистика продаж и клиентов' },
  },
  CATALOG: {
    key: 'CATALOG',
    core: false,
    comingSoon: false,
    icon: 'package',
    requires: [],
    label: { uz: 'Katalog', ru: 'Каталог' },
    description: {
      uz: 'Mahsulotlar, kategoriyalar, variantlar',
      ru: 'Товары, категории, варианты',
    },
  },
  SERVICES: {
    key: 'SERVICES',
    core: false,
    comingSoon: false,
    icon: 'scissors',
    requires: [],
    label: { uz: 'Xizmatlar', ru: 'Услуги' },
    description: { uz: 'Xizmatlar ro‘yxati va narxlari', ru: 'Список услуг и цены' },
  },
  ORDERS: {
    key: 'ORDERS',
    core: false,
    comingSoon: false,
    icon: 'shopping-bag',
    requires: ['CRM'],
    label: { uz: 'Buyurtmalar', ru: 'Заказы' },
    description: {
      uz: 'Savat, to‘lov va buyurtma holatlari',
      ru: 'Корзина, оплата и статусы заказов',
    },
  },
  BOOKING: {
    key: 'BOOKING',
    core: false,
    comingSoon: false,
    icon: 'calendar',
    requires: ['SERVICES', 'CRM'],
    label: { uz: 'Bronlar', ru: 'Записи' },
    description: { uz: 'Onlayn navbatga yozilish', ru: 'Онлайн-запись' },
  },
  PAYMENTS: {
    key: 'PAYMENTS',
    core: false,
    comingSoon: false,
    icon: 'credit-card',
    requires: [],
    label: { uz: 'To‘lovlar', ru: 'Платежи' },
    description: { uz: 'Click, Payme va naqd to‘lov', ru: 'Click, Payme и наличные' },
  },
  DELIVERY: {
    key: 'DELIVERY',
    core: false,
    comingSoon: false,
    icon: 'truck',
    requires: ['ORDERS'],
    label: { uz: 'Yetkazib berish', ru: 'Доставка' },
    description: { uz: 'Yetkazish zonalari va narxlari', ru: 'Зоны и стоимость доставки' },
  },
  BRANCHES: {
    key: 'BRANCHES',
    core: false,
    comingSoon: false,
    icon: 'map-pin',
    requires: [],
    label: { uz: 'Filiallar', ru: 'Филиалы' },
    description: { uz: 'Bir nechta manzil va ish vaqti', ru: 'Несколько адресов и график' },
  },
  EMPLOYEES: {
    key: 'EMPLOYEES',
    core: false,
    comingSoon: false,
    icon: 'user-check',
    requires: [],
    label: { uz: 'Xodimlar', ru: 'Сотрудники' },
    description: { uz: 'Xodimlar, jadval va xizmatlari', ru: 'Сотрудники, график и услуги' },
  },
  INVENTORY: {
    key: 'INVENTORY',
    core: false,
    comingSoon: false,
    icon: 'archive',
    requires: ['CATALOG'],
    label: { uz: 'Ombor', ru: 'Склад' },
    description: { uz: 'Qoldiq, kirim-chiqim', ru: 'Остатки, приход и расход' },
  },
  LOYALTY: {
    key: 'LOYALTY',
    core: false,
    comingSoon: false,
    icon: 'star',
    requires: ['CRM'],
    label: { uz: 'Bonus tizimi', ru: 'Бонусы' },
    description: { uz: 'Keshbek va bonus ballari', ru: 'Кэшбэк и бонусные баллы' },
  },
  PROMOCODES: {
    key: 'PROMOCODES',
    core: false,
    comingSoon: false,
    icon: 'tag',
    requires: [],
    label: { uz: 'Promokodlar', ru: 'Промокоды' },
    description: { uz: 'Chegirma kodlari va aksiyalar', ru: 'Скидочные коды и акции' },
  },
  MESSAGES: {
    key: 'MESSAGES',
    core: false,
    comingSoon: false,
    icon: 'message-circle',
    requires: ['CRM'],
    label: { uz: 'Xabarlar', ru: 'Сообщения' },
    description: { uz: 'Mijozlar bilan yozishmalar', ru: 'Переписка с клиентами' },
  },
  MARKETING: {
    key: 'MARKETING',
    core: false,
    comingSoon: true,
    icon: 'megaphone',
    requires: ['CRM'],
    label: { uz: 'Marketing', ru: 'Маркетинг' },
    description: { uz: 'Kampaniyalar va tarqatmalar', ru: 'Кампании и рассылки' },
  },
  POS: {
    key: 'POS',
    core: false,
    comingSoon: true,
    icon: 'monitor',
    requires: ['CATALOG', 'ORDERS', 'PAYMENTS'],
    label: { uz: 'Kassa (POS)', ru: 'Касса (POS)' },
    description: { uz: 'Oflayn savdo nuqtasi', ru: 'Офлайн точка продаж' },
  },
  FINANCE: {
    key: 'FINANCE',
    core: false,
    comingSoon: true,
    icon: 'wallet',
    requires: [],
    label: { uz: 'Moliya', ru: 'Финансы' },
    description: { uz: 'Xarajatlar va foyda', ru: 'Расходы и прибыль' },
  },
  SUPPLIERS: {
    key: 'SUPPLIERS',
    core: false,
    comingSoon: true,
    icon: 'truck',
    requires: ['INVENTORY'],
    label: { uz: 'Yetkazib beruvchilar', ru: 'Поставщики' },
    description: { uz: 'Ta’minot va xaridlar', ru: 'Снабжение и закупки' },
  },
  AI: {
    key: 'AI',
    core: false,
    comingSoon: true,
    icon: 'sparkles',
    requires: ['CRM'],
    label: { uz: 'AI yordamchi', ru: 'AI-ассистент' },
    description: { uz: 'Avtomatik javoblar va tahlil', ru: 'Автоответы и аналитика' },
  },
  AUTOMATION: {
    key: 'AUTOMATION',
    core: false,
    comingSoon: true,
    icon: 'zap',
    requires: [],
    label: { uz: 'Avtomatizatsiya', ru: 'Автоматизация' },
    description: { uz: 'Trigger va avtomatik amallar', ru: 'Триггеры и автодействия' },
  },
};

export const CORE_MODULES: readonly ModuleKey[] = MODULES.filter((m) => MODULE_DEFINITIONS[m].core);

export const AVAILABLE_MODULES: readonly ModuleKey[] = MODULES.filter(
  (m) => !MODULE_DEFINITIONS[m].comingSoon,
);

/** Missing dependencies for a module, given the currently enabled set. */
export function missingDependencies(module: ModuleKey, enabled: Iterable<ModuleKey>): ModuleKey[] {
  const set = new Set(enabled);
  return MODULE_DEFINITIONS[module].requires.filter((dep) => !set.has(dep));
}

/** Modules that would break if `module` were disabled. */
export function dependentsOf(module: ModuleKey, enabled: Iterable<ModuleKey>): ModuleKey[] {
  return [...enabled].filter((m) => MODULE_DEFINITIONS[m].requires.includes(module));
}

/** Expands a selection to include everything it depends on, transitively. */
export function withDependencies(selection: Iterable<ModuleKey>): ModuleKey[] {
  const result = new Set<ModuleKey>(CORE_MODULES);
  const visit = (m: ModuleKey) => {
    if (result.has(m)) return;
    result.add(m);
    MODULE_DEFINITIONS[m].requires.forEach(visit);
  };
  for (const m of selection) visit(m);
  return MODULES.filter((m) => result.has(m));
}
