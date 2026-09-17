import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { CUSTOMER_KEY, PERMISSION_KEY, PLATFORM_KEY, PUBLIC_KEY, SELF_KEY } from '../common/decorators';
import { logger } from '../common/logger';

/**
 * Boot-time route audit.
 *
 * Enumerates every controller route and refuses to start if one is neither @Public,
 * @CustomerRoute, @RequirePlatformRole nor annotated with @RequirePermission.
 *
 * This is the difference between "we have a permissions system" and "every route is
 * actually covered by it". Forgetting the decorator becomes a failed deploy instead of a
 * silently open endpoint — the failure mode that authorization bugs almost always take
 * (docs/architecture/03-rbac-permissions.md).
 */
@Injectable()
export class RouteAuditService implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap() {
    const unannotated: string[] = [];
    let audited = 0;

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance;
      if (!instance || !Object.getPrototypeOf(instance)) continue;

      const controllerClass = wrapper.metatype;
      if (!controllerClass) continue;
      const basePath = Reflect.getMetadata(PATH_METADATA, controllerClass) ?? '';

      for (const methodName of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const handler = (instance as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        // Only real routes carry a path; helper methods do not.
        const routePath = Reflect.getMetadata(PATH_METADATA, handler);
        if (routePath === undefined) continue;

        audited++;
        const targets = [handler as never, controllerClass as never];
        const covered =
          this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) === true ||
          this.reflector.getAllAndOverride<boolean>(CUSTOMER_KEY, targets) === true ||
          this.reflector.getAllAndOverride<boolean>(SELF_KEY, targets) === true ||
          this.reflector.getAllAndOverride<string[]>(PLATFORM_KEY, targets) !== undefined ||
          (this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, targets)?.length ?? 0) > 0;

        if (!covered) {
          const fullPath = `/${[basePath, routePath].filter((p) => p && p !== '/').join('/')}`;
          unannotated.push(`${controllerClass.name}.${methodName} (${fullPath})`);
        }
      }
    }

    if (unannotated.length > 0) {
      const detail = unannotated.map((r) => `  • ${r}`).join('\n');
      throw new Error(
        `Refusing to start: ${unannotated.length} route(s) declare no authorization.\n${detail}\n\n` +
          `Add @RequirePermission(...) for a tenant-scoped route, @AuthenticatedRoute() for ` +
          `one that acts on the caller's own account, or @Public()/@CustomerRoute()/` +
          `@RequirePlatformRole(...) if that is genuinely intended.`,
      );
    }

    logger.info({ routes: audited }, 'Route authorization audit passed');
  }
}
