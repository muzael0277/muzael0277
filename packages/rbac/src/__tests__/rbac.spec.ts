import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  permissionsForRole,
  effectivePermissions,
  roleHasPermission,
  canAssignRole,
  ROLES,
} from '../index';
import {
  MODULE_DEFINITIONS,
  missingDependencies,
  dependentsOf,
  withDependencies,
  CORE_MODULES,
} from '../modules';
import { TEMPLATE_DEFINITIONS, recommendTemplate } from '../templates';

describe('role matrix', () => {
  it('gives OWNER every permission, including ones added later', () => {
    const owner = permissionsForRole('OWNER');
    for (const p of PERMISSIONS) expect(owner.has(p), p).toBe(true);
  });

  it('withholds settings and integrations from everyone below ADMIN', () => {
    for (const role of ['MANAGER', 'OPERATOR', 'EMPLOYEE', 'COURIER'] as const) {
      expect(roleHasPermission(role, 'settings:write'), role).toBe(false);
      expect(roleHasPermission(role, 'integration:write'), role).toBe(false);
    }
  });

  it('reserves billing, tenant deletion and role changes for OWNER alone', () => {
    for (const role of ROLES.filter((r) => r !== 'OWNER')) {
      expect(roleHasPermission(role, 'tenant:billing'), role).toBe(false);
      expect(roleHasPermission(role, 'tenant:delete'), role).toBe(false);
      expect(roleHasPermission(role, 'member:role'), role).toBe(false);
    }
  });

  it('never lets ADMIN edit integration secrets', () => {
    // ADMIN can view integrations, but payment credentials are owner-only.
    expect(roleHasPermission('ADMIN', 'integration:read')).toBe(true);
    expect(roleHasPermission('ADMIN', 'integration:write')).toBe(false);
  });

  it('separates financial analytics from ordinary analytics', () => {
    expect(roleHasPermission('MANAGER', 'analytics:read')).toBe(true);
    expect(roleHasPermission('MANAGER', 'analytics:financial')).toBe(false);
    expect(roleHasPermission('ACCOUNTANT', 'analytics:financial')).toBe(true);
  });

  it('gives EMPLOYEE a read-only sliver', () => {
    const employee = permissionsForRole('EMPLOYEE');
    expect(employee.has('booking:read')).toBe(true);
    expect([...employee].every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('gives COURIER only what a delivery run needs', () => {
    expect([...permissionsForRole('COURIER')].sort()).toEqual(['order:read', 'order:status']);
  });

  it('starts CUSTOM empty so a custom role is opt-in, never opt-out', () => {
    expect(permissionsForRole('CUSTOM').size).toBe(0);
  });
});

describe('permission overrides', () => {
  it('grants extra permissions to a specific membership', () => {
    const perms = effectivePermissions('MANAGER', { grant: ['analytics:financial'] });
    expect(perms.has('analytics:financial')).toBe(true);
    // The base role is not mutated by an override.
    expect(permissionsForRole('MANAGER').has('analytics:financial')).toBe(false);
  });

  it('lets revoke win over grant, so a deny is never silently overridden', () => {
    const perms = effectivePermissions('ADMIN', {
      grant: ['order:refund'],
      revoke: ['order:refund'],
    });
    expect(perms.has('order:refund')).toBe(false);
  });
});

describe('role assignment', () => {
  it('lets OWNER assign anything', () => {
    expect(canAssignRole('OWNER', 'ADMIN')).toBe(true);
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
  });

  it('forbids assigning a role at or above your own rank (privilege escalation)', () => {
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('MANAGER', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'MANAGER')).toBe(true);
  });
});

describe('module dependencies', () => {
  it('reports what a module still needs', () => {
    expect(missingDependencies('BOOKING', ['CRM'])).toEqual(['SERVICES']);
    expect(missingDependencies('BOOKING', ['CRM', 'SERVICES'])).toEqual([]);
  });

  it('reports what would break if a module were disabled', () => {
    expect(dependentsOf('SERVICES', ['BOOKING', 'CRM', 'SERVICES'])).toEqual(['BOOKING']);
  });

  it('expands a selection to a consistent set, including core modules', () => {
    const expanded = withDependencies(['BOOKING']);
    expect(expanded).toContain('SERVICES');
    expect(expanded).toContain('CRM');
    for (const core of CORE_MODULES) expect(expanded).toContain(core);
  });

  it('declares no dependency that is itself unavailable', () => {
    for (const def of Object.values(MODULE_DEFINITIONS)) {
      for (const dep of def.requires) {
        expect(MODULE_DEFINITIONS[dep], `${def.key} -> ${dep}`).toBeDefined();
        // A shippable module must not depend on one that is still coming soon.
        if (!def.comingSoon)
          expect(MODULE_DEFINITIONS[dep].comingSoon, `${def.key} -> ${dep}`).toBe(false);
      }
    }
  });
});

describe('business templates', () => {
  it('ships every template with a self-consistent module set', () => {
    for (const template of Object.values(TEMPLATE_DEFINITIONS)) {
      for (const module of template.modules) {
        expect(missingDependencies(module, template.modules), `${template.key}/${module}`).toEqual(
          [],
        );
      }
    }
  });

  it('enables booking for appointment businesses and orders for commerce ones', () => {
    expect(TEMPLATE_DEFINITIONS.BEAUTY.modules).toContain('BOOKING');
    expect(TEMPLATE_DEFINITIONS.SERVICE.modules).toContain('BOOKING');
    expect(TEMPLATE_DEFINITIONS.RESTAURANT.modules).toContain('ORDERS');
    expect(TEMPLATE_DEFINITIONS.ONLINE_STORE.modules).toContain('ORDERS');
    expect(TEMPLATE_DEFINITIONS.ONLINE_STORE.modules).not.toContain('BOOKING');
  });
});

describe('smart onboarding', () => {
  it('routes a cafe to the restaurant template', () => {
    const result = recommendTemplate({
      sellsProducts: true,
      takesBookings: false,
      servesFood: true,
      delivers: true,
      branchCount: 2,
      hasEmployeeSchedules: false,
      tracksStock: true,
    });
    expect(result.template).toBe('RESTAURANT');
    expect(result.modules).toContain('DELIVERY');
    expect(result.modules).toContain('BRANCHES');
    expect(result.modules).toContain('INVENTORY');
  });

  it('routes a barbershop to the beauty template', () => {
    const result = recommendTemplate({
      sellsProducts: false,
      takesBookings: true,
      servesFood: false,
      delivers: false,
      branchCount: 1,
      hasEmployeeSchedules: true,
      tracksStock: false,
    });
    expect(result.template).toBe('BEAUTY');
    expect(result.modules).toContain('BOOKING');
    expect(result.modules).not.toContain('DELIVERY');
  });

  it('gives a salon that also sells products both booking and a catalog', () => {
    const result = recommendTemplate({
      sellsProducts: true,
      takesBookings: true,
      servesFood: false,
      delivers: false,
      branchCount: 1,
      hasEmployeeSchedules: true,
      tracksStock: false,
    });
    expect(result.template).toBe('BEAUTY');
    expect(result.modules).toContain('BOOKING');
    expect(result.modules).toContain('CATALOG');
    expect(result.modules).toContain('ORDERS');
  });

  it('produces a dependency-complete module set for every answer combination', () => {
    const bools = [true, false];
    for (const sellsProducts of bools)
      for (const takesBookings of bools)
        for (const servesFood of bools)
          for (const delivers of bools)
            for (const hasEmployeeSchedules of bools)
              for (const tracksStock of bools) {
                const { modules } = recommendTemplate({
                  sellsProducts,
                  takesBookings,
                  servesFood,
                  delivers,
                  branchCount: 1,
                  hasEmployeeSchedules,
                  tracksStock,
                });
                for (const m of modules) {
                  expect(missingDependencies(m, modules), JSON.stringify({ m, modules })).toEqual(
                    [],
                  );
                }
              }
  });
});
