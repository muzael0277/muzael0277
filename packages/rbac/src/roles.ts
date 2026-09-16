import { PERMISSIONS, type Permission } from './permissions';

export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'OPERATOR',
  'EMPLOYEE',
  'ACCOUNTANT',
  'COURIER',
  'CUSTOM',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Role → permissions. The authoritative matrix; see
 * docs/architecture/03-rbac-permissions.md for the rationale behind each row.
 *
 * OWNER is special-cased to every permission, so a new permission is never accidentally
 * withheld from the person who owns the business.
 */
const MATRIX: Record<Exclude<Role, 'OWNER' | 'CUSTOM'>, readonly Permission[]> = {
  ADMIN: [
    'customer:read', 'customer:write', 'customer:delete', 'customer:export',
    'product:read', 'product:write', 'product:delete',
    'service:read', 'service:write', 'service:delete',
    'order:read', 'order:write', 'order:status', 'order:cancel', 'order:refund',
    'booking:read', 'booking:write', 'booking:cancel', 'booking:reassign',
    'employee:read', 'employee:write', 'branch:read', 'branch:write',
    'inventory:read', 'inventory:write',
    'loyalty:read', 'loyalty:adjust', 'promo:read', 'promo:write',
    'message:read', 'message:write', 'message:assign',
    'analytics:read', 'analytics:financial',
    'settings:read', 'settings:write',
    'integration:read',
    'member:read', 'member:invite',
    'audit:read',
  ],
  MANAGER: [
    'customer:read', 'customer:write',
    'product:read', 'product:write',
    'service:read', 'service:write',
    'order:read', 'order:write', 'order:status', 'order:cancel',
    'booking:read', 'booking:write', 'booking:cancel', 'booking:reassign',
    'employee:read', 'branch:read',
    'inventory:read', 'inventory:write',
    'loyalty:read', 'loyalty:adjust',
    'promo:read', 'promo:write',
    'message:read', 'message:write', 'message:assign',
    'analytics:read',
    'settings:read',
  ],
  OPERATOR: [
    'customer:read', 'customer:write',
    'product:read', 'service:read',
    'order:read', 'order:status',
    'booking:read',
    'loyalty:read',
    'message:read', 'message:write',
    'branch:read',
  ],
  EMPLOYEE: [
    'booking:read',
    'service:read', 'product:read',
    'customer:read',
  ],
  ACCOUNTANT: [
    'customer:read',
    'order:read', 'product:read', 'service:read',
    'inventory:read',
    'loyalty:read',
    'analytics:read', 'analytics:financial',
  ],
  COURIER: [
    'order:read', 'order:status',
  ],
};

const CACHE = new Map<Role, ReadonlySet<Permission>>();

/** Base permission set for a role, before per-membership overrides. */
export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  const cached = CACHE.get(role);
  if (cached) return cached;

  const set: ReadonlySet<Permission> =
    role === 'OWNER'
      ? new Set(PERMISSIONS)
      : role === 'CUSTOM'
        ? new Set<Permission>()
        : new Set(MATRIX[role]);

  CACHE.set(role, set);
  return set;
}

/**
 * Per-membership overrides, the path to custom roles without a migration.
 * `grant` adds, `revoke` removes, and revoke wins — a deny is never silently overridden.
 */
export interface PermissionOverrides {
  grant?: Permission[];
  revoke?: Permission[];
}

export function effectivePermissions(
  role: Role,
  overrides?: PermissionOverrides | null,
): ReadonlySet<Permission> {
  if (!overrides || (!overrides.grant?.length && !overrides.revoke?.length)) {
    return permissionsForRole(role);
  }
  const set = new Set(permissionsForRole(role));
  for (const p of overrides.grant ?? []) set.add(p);
  for (const p of overrides.revoke ?? []) set.delete(p);
  return set;
}

export function roleHasPermission(
  role: Role,
  permission: Permission,
  overrides?: PermissionOverrides | null,
): boolean {
  return effectivePermissions(role, overrides).has(permission);
}

/**
 * Roles offered in the invite UI. ACCOUNTANT and COURIER exist in the matrix and are
 * enforced correctly, but are not surfaced until their dedicated screens ship.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = ['ADMIN', 'MANAGER', 'OPERATOR', 'EMPLOYEE'];

/** A role may only be assigned by someone whose own role outranks it. */
const RANK: Record<Role, number> = {
  OWNER: 100, ADMIN: 80, MANAGER: 60, ACCOUNTANT: 50,
  OPERATOR: 40, COURIER: 30, EMPLOYEE: 20, CUSTOM: 10,
};

export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'OWNER') return true;
  return RANK[actorRole] > RANK[targetRole];
}

export const ROLE_LABELS: Record<Role, { uz: string; ru: string }> = {
  OWNER: { uz: 'Egasi', ru: 'Владелец' },
  ADMIN: { uz: 'Administrator', ru: 'Администратор' },
  MANAGER: { uz: 'Menejer', ru: 'Менеджер' },
  OPERATOR: { uz: 'Operator', ru: 'Оператор' },
  EMPLOYEE: { uz: 'Xodim', ru: 'Сотрудник' },
  ACCOUNTANT: { uz: 'Buxgalter', ru: 'Бухгалтер' },
  COURIER: { uz: 'Kuryer', ru: 'Курьер' },
  CUSTOM: { uz: 'Maxsus rol', ru: 'Особая роль' },
};
