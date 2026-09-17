import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

export interface CachedTenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  templateKey: string;
  timezone: string;
  currency: string;
  defaultLanguage: string;
  primaryColor: string;
  logoUrl: string | null;
  enabledModules: Set<string>;
}

/**
 * Every authenticated request needs the tenant and its enabled modules. Without a cache
 * that is two queries per request before any business work happens; with one it is zero
 * in the common case.
 *
 * The TTL is short and invalidation is explicit on every write path that changes a
 * tenant or its modules, so a disabled module takes effect immediately rather than
 * within a minute.
 */
@Injectable()
export class TenantCache {
  private static readonly TTL_SECONDS = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private key(tenantId: string) { return `tenant:${tenantId}`; }
  private slugKey(slug: string) { return `tenant:slug:${slug}`; }

  async getTenant(tenantId: string): Promise<CachedTenant | null> {
    const cached = await this.redis.remember(this.key(tenantId), TenantCache.TTL_SECONDS, () =>
      this.load({ id: tenantId }),
    );
    return cached ? { ...cached, enabledModules: new Set(cached.enabledModules) } : null;
  }

  async getTenantBySlug(slug: string): Promise<CachedTenant | null> {
    const cached = await this.redis.remember(this.slugKey(slug), TenantCache.TTL_SECONDS, () =>
      this.load({ slug }),
    );
    return cached ? { ...cached, enabledModules: new Set(cached.enabledModules) } : null;
  }

  async invalidate(tenantId: string, slug?: string): Promise<void> {
    await this.redis.forget(this.key(tenantId), ...(slug ? [this.slugKey(slug)] : []));
  }

  private async load(
    where: { id: string } | { slug: string },
  ): Promise<(Omit<CachedTenant, 'enabledModules'> & { enabledModules: string[] }) | null> {
    // Resolving *which* tenant a request belongs to necessarily happens before a tenant
    // is in context, so this is one of the sanctioned system-context reads.
    const tenant = await this.prisma.system('resolve-tenant', () =>
      this.prisma.raw.tenant.findUnique({
        where: where as { id: string },
        select: {
          id: true, slug: true, name: true, status: true, templateKey: true,
          timezone: true, currency: true, defaultLanguage: true, primaryColor: true,
          logoUrl: true, deletedAt: true,
          modules: { where: { enabled: true }, select: { module: true } },
        },
      }),
    );

    if (!tenant || tenant.deletedAt) return null;
    const { modules, deletedAt: _deletedAt, ...rest } = tenant;
    return { ...rest, enabledModules: modules.map((m) => m.module) };
  }
}
