/**
 * Business templates.
 *
 * A template is configuration, never a code path. Adding a vertical means adding a
 * definition here (and eventually a row in the database that tenants can author), not a
 * new application. See docs/architecture/05-modules-and-templates.md.
 */

import type { ModuleKey } from './modules';

export const BUSINESS_TEMPLATES = [
  'ONLINE_STORE',
  'RESTAURANT',
  'BEAUTY',
  'SERVICE',
  'CUSTOM',
] as const;

export type BusinessTemplateKey = (typeof BUSINESS_TEMPLATES)[number];

export type FulfillmentType = 'DELIVERY' | 'PICKUP' | 'DINE_IN';
export type MiniAppTab =
  'home' | 'catalog' | 'menu' | 'services' | 'cart' | 'orders' | 'bookings' | 'bonus' | 'profile';

export interface TemplateDefinition {
  key: BusinessTemplateKey;
  label: { uz: string; ru: string };
  description: { uz: string; ru: string };
  icon: string;
  modules: readonly ModuleKey[];
  moduleConfig: Record<string, Record<string, unknown>>;
  miniAppTabs: readonly MiniAppTab[];
  orderPipeline: readonly string[];
  /** Verticals this template is pitched at, shown during onboarding. */
  examples: { uz: string[]; ru: string[] };
  /** Starter content created on apply, so the dashboard is never empty. */
  seed: {
    categories?: { uz: string; ru: string }[];
    modifierGroups?: {
      name: { uz: string; ru: string };
      minSelect: number;
      maxSelect: number;
      options: { name: { uz: string; ru: string }; price: number }[];
    }[];
  };
}

export const TEMPLATE_DEFINITIONS: Record<BusinessTemplateKey, TemplateDefinition> = {
  ONLINE_STORE: {
    key: 'ONLINE_STORE',
    icon: 'shopping-cart',
    label: { uz: 'Onlayn do‘kon', ru: 'Интернет-магазин' },
    description: {
      uz: 'Mahsulot sotish, yetkazib berish va to‘lovlar',
      ru: 'Продажа товаров, доставка и оплата',
    },
    examples: {
      uz: ['Kiyim do‘koni', 'Elektronika', 'Kosmetika', 'Gullar', 'Sport tovarlari'],
      ru: ['Магазин одежды', 'Электроника', 'Косметика', 'Цветы', 'Спорттовары'],
    },
    modules: [
      'CRM',
      'CATALOG',
      'ORDERS',
      'PAYMENTS',
      'DELIVERY',
      'INVENTORY',
      'PROMOCODES',
      'LOYALTY',
      'MESSAGES',
      'ANALYTICS',
      'TELEGRAM',
    ],
    moduleConfig: {
      ORDERS: { fulfillment: ['DELIVERY', 'PICKUP'] satisfies FulfillmentType[], minOrderTotal: 0 },
      LOYALTY: { type: 'CASHBACK', rate: 3 },
      DELIVERY: { flatFee: 15000, freeAbove: 300000 },
    },
    miniAppTabs: ['home', 'catalog', 'cart', 'orders', 'profile'],
    orderPipeline: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'DELIVERING', 'COMPLETED'],
    seed: {
      categories: [
        { uz: 'Yangi mahsulotlar', ru: 'Новинки' },
        { uz: 'Ommabop', ru: 'Популярное' },
        { uz: 'Chegirmalar', ru: 'Скидки' },
      ],
    },
  },

  RESTAURANT: {
    key: 'RESTAURANT',
    icon: 'utensils',
    label: { uz: 'Restoran / Kafe', ru: 'Ресторан / Кафе' },
    description: {
      uz: 'Menyu, yetkazib berish, olib ketish va zalga buyurtma',
      ru: 'Меню, доставка, самовывоз и заказ в зале',
    },
    examples: {
      uz: ['Restoran', 'Kafe', 'Fast food', 'Choyxona', 'Qahvaxona', 'Shirinliklar'],
      ru: ['Ресторан', 'Кафе', 'Фастфуд', 'Чайхана', 'Кофейня', 'Кондитерская'],
    },
    modules: [
      'CRM',
      'CATALOG',
      'ORDERS',
      'PAYMENTS',
      'DELIVERY',
      'BRANCHES',
      'INVENTORY',
      'LOYALTY',
      'PROMOCODES',
      'MESSAGES',
      'ANALYTICS',
      'TELEGRAM',
    ],
    moduleConfig: {
      ORDERS: {
        fulfillment: ['DELIVERY', 'PICKUP', 'DINE_IN'] satisfies FulfillmentType[],
        minOrderTotal: 50000,
      },
      LOYALTY: { type: 'CASHBACK', rate: 5 },
      DELIVERY: { flatFee: 15000, freeAbove: 200000 },
      CATALOG: { modifiersEnabled: true },
    },
    miniAppTabs: ['home', 'menu', 'cart', 'orders', 'profile'],
    orderPipeline: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'DELIVERING', 'COMPLETED'],
    seed: {
      categories: [
        { uz: 'Milliy taomlar', ru: 'Национальные блюда' },
        { uz: 'Salatlar', ru: 'Салаты' },
        { uz: 'Fast food', ru: 'Фастфуд' },
        { uz: 'Ichimliklar', ru: 'Напитки' },
        { uz: 'Shirinliklar', ru: 'Десерты' },
      ],
      modifierGroups: [
        {
          name: { uz: 'Hajmi', ru: 'Размер' },
          minSelect: 1,
          maxSelect: 1,
          options: [
            { name: { uz: 'Kichik', ru: 'Маленький' }, price: 0 },
            { name: { uz: 'O‘rta', ru: 'Средний' }, price: 8000 },
            { name: { uz: 'Katta', ru: 'Большой' }, price: 15000 },
          ],
        },
        {
          name: { uz: 'Qo‘shimchalar', ru: 'Добавки' },
          minSelect: 0,
          maxSelect: 5,
          options: [
            { name: { uz: 'Qo‘shimcha pishloq', ru: 'Дополнительный сыр' }, price: 8000 },
            { name: { uz: 'Qo‘shimcha go‘sht', ru: 'Дополнительное мясо' }, price: 15000 },
            { name: { uz: 'Achchiq sous', ru: 'Острый соус' }, price: 3000 },
            { name: { uz: 'Piyozsiz', ru: 'Без лука' }, price: 0 },
          ],
        },
      ],
    },
  },

  BEAUTY: {
    key: 'BEAUTY',
    icon: 'scissors',
    label: { uz: 'Go‘zallik salon / Barbershop', ru: 'Салон красоты / Барбершоп' },
    description: {
      uz: 'Onlayn navbat, xodimlar jadvali va bonuslar',
      ru: 'Онлайн-запись, график мастеров и бонусы',
    },
    examples: {
      uz: ['Barbershop', 'Go‘zallik saloni', 'Manikyur studiyasi', 'SPA', 'Massaj'],
      ru: ['Барбершоп', 'Салон красоты', 'Ногтевая студия', 'СПА', 'Массаж'],
    },
    modules: [
      'CRM',
      'SERVICES',
      'BOOKING',
      'EMPLOYEES',
      'BRANCHES',
      'PAYMENTS',
      'LOYALTY',
      'PROMOCODES',
      'MESSAGES',
      'ANALYTICS',
      'TELEGRAM',
    ],
    moduleConfig: {
      BOOKING: {
        slotStepMinutes: 15,
        minLeadTimeMinutes: 60,
        maxAdvanceDays: 30,
        autoConfirm: true,
        reminderOffsetsMinutes: [1440, 120],
      },
      LOYALTY: { type: 'CASHBACK', rate: 5 },
    },
    miniAppTabs: ['home', 'services', 'bookings', 'bonus', 'profile'],
    orderPipeline: ['NEW', 'ACCEPTED', 'COMPLETED'],
    seed: {
      categories: [
        { uz: 'Soch', ru: 'Волосы' },
        { uz: 'Soqol', ru: 'Борода' },
        { uz: 'Parvarish', ru: 'Уход' },
      ],
    },
  },

  SERVICE: {
    key: 'SERVICE',
    icon: 'briefcase',
    label: { uz: 'Xizmat ko‘rsatish', ru: 'Сфера услуг' },
    description: {
      uz: 'Klinika, avtoservis, o‘quv markazi va konsalting',
      ru: 'Клиника, автосервис, учебный центр и консалтинг',
    },
    examples: {
      uz: ['Klinika', 'Stomatologiya', 'Avtoservis', 'O‘quv markazi', 'Yuridik xizmat', 'Tozalash'],
      ru: ['Клиника', 'Стоматология', 'Автосервис', 'Учебный центр', 'Юруслуги', 'Клининг'],
    },
    modules: [
      'CRM',
      'SERVICES',
      'BOOKING',
      'EMPLOYEES',
      'BRANCHES',
      'PAYMENTS',
      'MESSAGES',
      'ANALYTICS',
      'TELEGRAM',
    ],
    moduleConfig: {
      BOOKING: {
        slotStepMinutes: 30,
        minLeadTimeMinutes: 120,
        maxAdvanceDays: 60,
        autoConfirm: false,
        reminderOffsetsMinutes: [1440, 120],
      },
    },
    miniAppTabs: ['home', 'services', 'bookings', 'profile'],
    orderPipeline: ['NEW', 'ACCEPTED', 'COMPLETED'],
    seed: {
      categories: [
        { uz: 'Asosiy xizmatlar', ru: 'Основные услуги' },
        { uz: 'Qo‘shimcha xizmatlar', ru: 'Дополнительные услуги' },
      ],
    },
  },

  CUSTOM: {
    key: 'CUSTOM',
    icon: 'settings',
    label: { uz: 'Boshqa biznes', ru: 'Другой бизнес' },
    description: {
      uz: 'Kerakli modullarni o‘zingiz tanlang',
      ru: 'Выберите нужные модули самостоятельно',
    },
    examples: {
      uz: ['Ko‘chmas mulk', 'Mehmonxona', 'Distribyutor', 'Boshqa'],
      ru: ['Недвижимость', 'Отель', 'Дистрибуция', 'Другое'],
    },
    modules: ['CRM', 'MESSAGES', 'ANALYTICS', 'TELEGRAM'],
    moduleConfig: {},
    miniAppTabs: ['home', 'profile'],
    orderPipeline: ['NEW', 'ACCEPTED', 'COMPLETED'],
    seed: {},
  },
};

/**
 * Smart onboarding: maps plain business answers to a template + module deltas, so the
 * owner never has to understand the word "module".
 *
 * Pure function — unit-tested, no I/O.
 */
export interface OnboardingAnswers {
  sellsProducts: boolean;
  takesBookings: boolean;
  servesFood: boolean;
  delivers: boolean;
  branchCount: number;
  hasEmployeeSchedules: boolean;
  tracksStock: boolean;
}

export function recommendTemplate(answers: OnboardingAnswers): {
  template: BusinessTemplateKey;
  modules: ModuleKey[];
} {
  let template: BusinessTemplateKey;
  if (answers.servesFood) template = 'RESTAURANT';
  else if (answers.takesBookings && answers.hasEmployeeSchedules) template = 'BEAUTY';
  else if (answers.takesBookings) template = 'SERVICE';
  else if (answers.sellsProducts) template = 'ONLINE_STORE';
  else template = 'CUSTOM';

  const modules = new Set<ModuleKey>(TEMPLATE_DEFINITIONS[template].modules);

  // Answers refine the preset — a salon that also sells products gets a catalog.
  if (answers.sellsProducts) {
    modules.add('CATALOG');
    modules.add('ORDERS');
  }
  if (answers.takesBookings) {
    modules.add('SERVICES');
    modules.add('BOOKING');
  }
  if (answers.delivers && modules.has('ORDERS')) modules.add('DELIVERY');
  else modules.delete('DELIVERY');
  if (answers.branchCount > 1) modules.add('BRANCHES');
  if (answers.hasEmployeeSchedules) modules.add('EMPLOYEES');
  if (answers.tracksStock && modules.has('CATALOG')) modules.add('INVENTORY');
  else modules.delete('INVENTORY');

  return { template, modules: [...modules] };
}
