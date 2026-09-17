import { Injectable } from '@nestjs/common';
import {
  TEMPLATE_DEFINITIONS, withDependencies, missingDependencies, dependentsOf,
  MODULE_DEFINITIONS, CORE_MODULES,
  type BusinessTemplateKey, type ModuleKey,
} from '@bizbot/rbac';
import { DomainError, ErrorCode, slugify, type I18nValue } from '@bizbot/shared';
import type { CreateTenantInput } from '@bizbot/contracts';
import type { Prisma } from '@bizbot/database';
import { PrismaService } from '../../infra/prisma.service';
import { TenantCache } from '../../infra/tenant-cache.service';
import { AuditService } from '../audit/audit.service';

/**
 * Tenant lifecycle and the template engine.
 *
 * Applying a template writes configuration — modules, settings, starter content — and
 * then detaches. The tenant may toggle anything afterwards, and the template is never
 * silently re-applied. `templateKey` is kept for analytics and defaults only
 * (docs/architecture/05-modules-and-templates.md).
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: TenantCache,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, input: CreateTenantInput) {
    const templateKey = input.templateKey as BusinessTemplateKey;
    const template = TEMPLATE_DEFINITIONS[templateKey];
    if (!template) throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Unknown business template');

    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name));
    const modules = withDependencies(template.modules);

    // Tenant creation is inherently cross-tenant (no tenant exists yet), and every part
    // must land together — a business with no owner membership is unreachable forever.
    const tenant = await this.prisma.system('create-tenant', () =>
      this.prisma.raw.$transaction(async (tx) => {
        const created = await tx.tenant.create({
          data: {
            slug,
            name: input.name,
            templateKey,
            status: 'ONBOARDING',
            timezone: input.timezone ?? 'Asia/Tashkent',
            currency: input.currency ?? 'UZS',
            defaultLanguage: input.defaultLanguage ?? 'uz',
            onboardingStep: 2,
            settings: {
              create: {
                phone: input.phone,
                workingHours: defaultWorkingHours() as Prisma.InputJsonValue,
                deliverySettings: (template.moduleConfig.DELIVERY ?? {}) as Prisma.InputJsonValue,
                bookingSettings: (template.moduleConfig.BOOKING ?? defaultBookingSettings()) as Prisma.InputJsonValue,
                loyaltySettings: (template.moduleConfig.LOYALTY ?? { enabled: false }) as Prisma.InputJsonValue,
              },
            },
            modules: {
              create: modules.map((module) => ({
                module,
                enabled: true,
                config: (template.moduleConfig[module] ?? {}) as Prisma.InputJsonValue,
              })),
            },
            memberships: { create: { userId, role: 'OWNER' } },
          },
        });

        await this.applyTemplateContent(tx, created.id, templateKey);
        await this.createSystemSegments(tx, created.id);
        await this.startTrial(tx, created.id);
        return created;
      }),
    );

    await this.audit.record({
      tenantId: tenant.id, actorUserId: userId, action: 'tenant.created',
      entityType: 'TENANT', entityId: tenant.id, after: { name: tenant.name, templateKey },
    });

    return this.detail(tenant.id);
  }

  async detail(tenantId: string) {
    const tenant = await this.prisma.system('tenant-detail', () =>
      this.prisma.raw.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: {
          settings: true,
          modules: { orderBy: { module: 'asc' } },
          subscription: { include: { plan: { include: { features: true } } } },
          _count: { select: { customers: true, orders: true, bookings: true, products: true, services: true } },
        },
      }),
    );

    return {
      id: tenant.id, slug: tenant.slug, name: tenant.name,
      templateKey: tenant.templateKey, status: tenant.status,
      logoUrl: tenant.logoUrl, primaryColor: tenant.primaryColor,
      timezone: tenant.timezone, currency: tenant.currency,
      defaultLanguage: tenant.defaultLanguage,
      onboardingStep: tenant.onboardingStep,
      onboardingCompleted: tenant.onboardingCompletedAt !== null,
      isDemo: tenant.isDemo,
      settings: tenant.settings,
      modules: tenant.modules.map((m) => ({
        module: m.module, enabled: m.enabled, config: m.config,
        label: MODULE_DEFINITIONS[m.module as ModuleKey]?.label,
        core: MODULE_DEFINITIONS[m.module as ModuleKey]?.core ?? false,
      })),
      plan: tenant.subscription
        ? {
            key: tenant.subscription.plan.key,
            status: tenant.subscription.status,
            currentPeriodEnd: tenant.subscription.currentPeriodEnd,
            features: Object.fromEntries(
              tenant.subscription.plan.features.map((f) => [f.key, f.limit ?? f.enabled]),
            ),
          }
        : null,
      counts: tenant._count,
    };
  }

  async update(tenantId: string, userId: string, data: Record<string, unknown>) {
    const before = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const after = await this.prisma.client.tenant.update({ where: { id: tenantId }, data });

    await this.cache.invalidate(tenantId, before.slug);
    await this.audit.recordChange(
      { tenantId, actorUserId: userId, action: 'tenant.updated', entityType: 'TENANT', entityId: tenantId },
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    return this.detail(tenantId);
  }

  async updateSettings(tenantId: string, userId: string, data: Record<string, unknown>) {
    const before = await this.prisma.client.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
    const after = await this.prisma.client.tenantSettings.update({ where: { tenantId }, data });

    await this.cache.invalidate(tenantId);
    await this.audit.recordChange(
      { tenantId, actorUserId: userId, action: 'tenant.settings_updated', entityType: 'TENANT_SETTINGS', entityId: tenantId },
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    return after;
  }

  // ── modules ──────────────────────────────────────────────────────────────────

  async setModule(tenantId: string, userId: string, module: ModuleKey, enabled: boolean) {
    const definition = MODULE_DEFINITIONS[module];
    if (!definition) throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Unknown module');
    if (definition.comingSoon) {
      throw new DomainError(ErrorCode.MODULE_NOT_AVAILABLE, 'This module is not available yet', { module });
    }

    const rows = await this.prisma.client.tenantModule.findMany({ where: { tenantId } });
    const currentlyEnabled = rows.filter((r) => r.enabled).map((r) => r.module as ModuleKey);

    if (enabled) {
      const missing = missingDependencies(module, currentlyEnabled);
      if (missing.length > 0) {
        throw new DomainError(ErrorCode.MODULE_DEPENDENCY_MISSING, 'Enable the modules this one depends on first', {
          module, requires: missing,
        });
      }
    } else {
      if (definition.core) {
        throw new DomainError(ErrorCode.MODULE_IS_CORE, 'Core modules cannot be disabled', { module });
      }
      // Refuse to strand a dependent module, and say which one — a bare "cannot disable"
      // leaves the owner guessing.
      const dependents = dependentsOf(module, currentlyEnabled);
      if (dependents.length > 0) {
        throw new DomainError(ErrorCode.MODULE_HAS_DEPENDENTS, 'Other modules depend on this one', {
          module, dependents,
        });
      }
    }

    await this.prisma.client.tenantModule.upsert({
      where: { tenantId_module: { tenantId, module } },
      create: { tenantId, module, enabled },
      update: { enabled },
    });

    await this.cache.invalidate(tenantId);
    await this.audit.record({
      tenantId, actorUserId: userId,
      action: enabled ? 'module.enabled' : 'module.disabled',
      entityType: 'MODULE', entityId: module,
    });

    // Disabling never deletes data, so re-enabling restores the tenant's history.
    return this.listModules(tenantId);
  }

  async listModules(tenantId: string) {
    const rows = await this.prisma.client.tenantModule.findMany({ where: { tenantId } });
    const enabledSet = new Set(rows.filter((r) => r.enabled).map((r) => r.module as ModuleKey));

    return Object.values(MODULE_DEFINITIONS).map((definition) => ({
      key: definition.key,
      label: definition.label,
      description: definition.description,
      icon: definition.icon,
      core: definition.core,
      comingSoon: definition.comingSoon,
      requires: definition.requires,
      enabled: enabledSet.has(definition.key),
      missingDependencies: missingDependencies(definition.key, enabledSet),
      blockedBy: enabledSet.has(definition.key) ? dependentsOf(definition.key, enabledSet) : [],
      config: rows.find((r) => r.module === definition.key)?.config ?? {},
    }));
  }

  async advanceOnboarding(tenantId: string, step: number, complete: boolean) {
    const tenant = await this.prisma.client.tenant.update({
      where: { id: tenantId },
      data: {
        onboardingStep: step,
        ...(complete
          ? { onboardingCompletedAt: new Date(), status: 'ACTIVE' as const }
          : {}),
      },
    });
    await this.cache.invalidate(tenantId, tenant.slug);
    return { onboardingStep: tenant.onboardingStep, completed: tenant.onboardingCompletedAt !== null };
  }

  /**
   * Permanently deletes a business and everything it owns.
   *
   * Audit rows are append-only at the database level, so a cascade into AuditLog is
   * refused unless the transaction explicitly opts in. That opt-in is the point: ordinary
   * application code — and anyone who has compromised it — cannot erase an audit trail by
   * issuing a DELETE, while a deliberate erasure still has a supported path. The purge
   * itself is recorded before the flag is set, so the last thing in the trail is the
   * decision to destroy it.
   *
   * Used by the platform-admin surface and by test teardown.
   */
  async purge(tenantId: string, actorUserId: string | null, reason: string) {
    await this.audit.record({
      actorUserId, action: 'tenant.purged', entityType: 'TENANT', entityId: tenantId,
      after: { reason },
    });

    const tenant = await this.prisma.system('tenant-purge-read', () =>
      this.prisma.raw.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
    );

    await this.prisma.system('tenant-purge', () =>
      this.prisma.raw.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL bizbot.allow_audit_purge = 'on'`;
        await tx.tenant.delete({ where: { id: tenantId } });
      }),
    );

    if (tenant) await this.cache.invalidate(tenantId, tenant.slug);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async uniqueSlug(base: string): Promise<string> {
    const root = base || 'biznes';
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
      const taken = await this.prisma.system('slug-check', () =>
        this.prisma.raw.tenant.findUnique({ where: { slug: candidate }, select: { id: true } }),
      );
      if (!taken) return candidate;
    }
    return `${root}-${Date.now().toString(36)}`;
  }

  /** Starter content so the dashboard is never an empty shell on day one. */
  private async applyTemplateContent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateKey: BusinessTemplateKey,
  ) {
    const seed = TEMPLATE_DEFINITIONS[templateKey].seed;

    if (seed.categories?.length) {
      await tx.category.createMany({
        data: seed.categories.map((name, i) => ({
          tenantId, name: name as unknown as Prisma.InputJsonValue, sortOrder: i,
        })),
      });
    }

    for (const [i, group] of (seed.modifierGroups ?? []).entries()) {
      await tx.modifierGroup.create({
        data: {
          tenantId,
          name: group.name as unknown as Prisma.InputJsonValue,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          sortOrder: i,
          options: {
            create: group.options.map((option, oi) => ({
              tenantId,
              name: option.name as unknown as Prisma.InputJsonValue,
              price: option.price,
              sortOrder: oi,
            })),
          },
        },
      });
    }
  }

  private async createSystemSegments(tx: Prisma.TransactionClient, tenantId: string) {
    const segments: { key: string; name: I18nValue; filter: unknown }[] = [
      { key: 'new_customers', name: { uz: 'Yangi mijozlar', ru: 'Новые клиенты' },
        filter: { all: [{ field: 'orderCount', op: 'lte', value: 1 }] } },
      { key: 'repeat_customers', name: { uz: 'Qaytgan mijozlar', ru: 'Повторные клиенты' },
        filter: { all: [{ field: 'orderCount', op: 'gte', value: 2 }] } },
      { key: 'vip', name: { uz: 'VIP mijozlar', ru: 'VIP-клиенты' },
        filter: { all: [{ field: 'totalSpent', op: 'gte', value: 1_000_000 }] } },
      { key: 'inactive_30d', name: { uz: '30 kun faol emas', ru: 'Неактивны 30 дней' },
        filter: { all: [{ field: 'lastActivityAt', op: 'daysAgoGt', value: 30 }] } },
      { key: 'birthday_today', name: { uz: 'Bugun tug‘ilgan kun', ru: 'День рождения сегодня' },
        filter: { all: [{ field: 'birthDate', op: 'monthDayEq', value: 'today' }] } },
    ];

    await tx.customerSegment.createMany({
      data: segments.map((s) => ({
        tenantId, key: s.key, isSystem: true,
        name: s.name as Prisma.InputJsonValue,
        filter: s.filter as Prisma.InputJsonValue,
      })),
    });
  }

  private async startTrial(tx: Prisma.TransactionClient, tenantId: string) {
    const plan = await tx.plan.findUnique({ where: { key: 'START' } });
    if (!plan) return; // plans are seeded; a fresh install without them still works
    await tx.subscription.create({
      data: {
        tenantId, planId: plan.id, status: 'TRIALING',
        currentPeriodEnd: new Date(Date.now() + plan.trialDays * 86400_000),
      },
    });
  }
}

function defaultWorkingHours() {
  return Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: '09:00', end: '18:00' }]]),
  );
}

function defaultBookingSettings() {
  return {
    slotStepMinutes: 15, minLeadTimeMinutes: 60, maxAdvanceDays: 30,
    autoConfirm: true, requirePrepayment: false, cancellationDeadlineMinutes: 120,
    reminderOffsetsMinutes: [1440, 120],
  };
}

export { CORE_MODULES };
