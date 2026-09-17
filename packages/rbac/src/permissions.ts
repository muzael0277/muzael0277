/**
 * Permissions.
 *
 * `resource:action` strings, defined once and consumed by both the API (which enforces
 * them) and the admin app (which uses them to avoid rendering controls that would 403).
 * The frontend list is a courtesy; the backend check is the security boundary.
 */

export const PERMISSIONS = [
  'customer:read',
  'customer:write',
  'customer:delete',
  'customer:export',
  'product:read',
  'product:write',
  'product:delete',
  'service:read',
  'service:write',
  'service:delete',
  'order:read',
  'order:write',
  'order:status',
  'order:cancel',
  'order:refund',
  'booking:read',
  'booking:write',
  'booking:cancel',
  'booking:reassign',
  'employee:read',
  'employee:write',
  'branch:read',
  'branch:write',
  'inventory:read',
  'inventory:write',
  'loyalty:read',
  'loyalty:adjust',
  'promo:read',
  'promo:write',
  'message:read',
  'message:write',
  'message:assign',
  'analytics:read',
  'analytics:financial',
  'settings:read',
  'settings:write',
  'integration:read',
  'integration:write',
  'member:read',
  'member:invite',
  'member:role',
  'audit:read',
  'tenant:delete',
  'tenant:billing',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Human labels for the role editor, in the platform's primary languages. */
export const PERMISSION_LABELS: Record<Permission, { uz: string; ru: string }> = {
  'customer:read': { uz: 'Mijozlarni ko‘rish', ru: 'Просмотр клиентов' },
  'customer:write': { uz: 'Mijozlarni tahrirlash', ru: 'Редактирование клиентов' },
  'customer:delete': { uz: 'Mijozlarni o‘chirish', ru: 'Удаление клиентов' },
  'customer:export': { uz: 'Mijozlarni eksport qilish', ru: 'Экспорт клиентов' },
  'product:read': { uz: 'Mahsulotlarni ko‘rish', ru: 'Просмотр товаров' },
  'product:write': { uz: 'Mahsulotlarni tahrirlash', ru: 'Редактирование товаров' },
  'product:delete': { uz: 'Mahsulotlarni o‘chirish', ru: 'Удаление товаров' },
  'service:read': { uz: 'Xizmatlarni ko‘rish', ru: 'Просмотр услуг' },
  'service:write': { uz: 'Xizmatlarni tahrirlash', ru: 'Редактирование услуг' },
  'service:delete': { uz: 'Xizmatlarni o‘chirish', ru: 'Удаление услуг' },
  'order:read': { uz: 'Buyurtmalarni ko‘rish', ru: 'Просмотр заказов' },
  'order:write': { uz: 'Buyurtma yaratish', ru: 'Создание заказов' },
  'order:status': { uz: 'Buyurtma holatini o‘zgartirish', ru: 'Изменение статуса заказа' },
  'order:cancel': { uz: 'Buyurtmani bekor qilish', ru: 'Отмена заказа' },
  'order:refund': { uz: 'Pulni qaytarish', ru: 'Возврат средств' },
  'booking:read': { uz: 'Bronlarni ko‘rish', ru: 'Просмотр записей' },
  'booking:write': { uz: 'Bron yaratish', ru: 'Создание записей' },
  'booking:cancel': { uz: 'Bronni bekor qilish', ru: 'Отмена записи' },
  'booking:reassign': { uz: 'Bronni boshqa xodimga berish', ru: 'Переназначение записи' },
  'employee:read': { uz: 'Xodimlarni ko‘rish', ru: 'Просмотр сотрудников' },
  'employee:write': { uz: 'Xodimlarni tahrirlash', ru: 'Редактирование сотрудников' },
  'branch:read': { uz: 'Filiallarni ko‘rish', ru: 'Просмотр филиалов' },
  'branch:write': { uz: 'Filiallarni tahrirlash', ru: 'Редактирование филиалов' },
  'inventory:read': { uz: 'Omborni ko‘rish', ru: 'Просмотр склада' },
  'inventory:write': { uz: 'Ombor operatsiyalari', ru: 'Операции склада' },
  'loyalty:read': { uz: 'Bonuslarni ko‘rish', ru: 'Просмотр бонусов' },
  'loyalty:adjust': { uz: 'Bonuslarni o‘zgartirish', ru: 'Корректировка бонусов' },
  'promo:read': { uz: 'Promokodlarni ko‘rish', ru: 'Просмотр промокодов' },
  'promo:write': { uz: 'Promokodlarni tahrirlash', ru: 'Редактирование промокодов' },
  'message:read': { uz: 'Xabarlarni ko‘rish', ru: 'Просмотр сообщений' },
  'message:write': { uz: 'Xabar yuborish', ru: 'Отправка сообщений' },
  'message:assign': { uz: 'Suhbatni biriktirish', ru: 'Назначение диалога' },
  'analytics:read': { uz: 'Analitikani ko‘rish', ru: 'Просмотр аналитики' },
  'analytics:financial': { uz: 'Moliyaviy hisobotlar', ru: 'Финансовые отчёты' },
  'settings:read': { uz: 'Sozlamalarni ko‘rish', ru: 'Просмотр настроек' },
  'settings:write': { uz: 'Sozlamalarni o‘zgartirish', ru: 'Изменение настроек' },
  'integration:read': { uz: 'Integratsiyalarni ko‘rish', ru: 'Просмотр интеграций' },
  'integration:write': { uz: 'Integratsiyalarni sozlash', ru: 'Настройка интеграций' },
  'member:read': { uz: 'Jamoani ko‘rish', ru: 'Просмотр команды' },
  'member:invite': { uz: 'Xodim taklif qilish', ru: 'Приглашение сотрудников' },
  'member:role': { uz: 'Rollarni o‘zgartirish', ru: 'Изменение ролей' },
  'audit:read': { uz: 'Audit jurnali', ru: 'Журнал аудита' },
  'tenant:delete': { uz: 'Biznesni o‘chirish', ru: 'Удаление бизнеса' },
  'tenant:billing': { uz: 'To‘lov va tarif', ru: 'Оплата и тариф' },
};
