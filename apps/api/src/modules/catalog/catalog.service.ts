import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bizbot/database';
import {
  DomainError, ErrorCode, normalizePageParams, paginate, toSkipTake,
  type I18nValue,
} from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Catalog.
 *
 * Every read and write here goes through the guarded Prisma client, so none of these
 * methods take or check a tenantId — the request context supplies it and the guard
 * enforces it. A method that needed an explicit tenantId would be a sign something had
 * escaped the pattern.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── categories ───────────────────────────────────────────────────────────────

  async listCategories(options: { includeInactive?: boolean } = {}) {
    const categories = await this.prisma.client.category.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { products: true, services: true } } },
    });

    // Return a tree; the admin sidebar and the Mini App both want nesting, and building
    // it once here beats two client implementations that disagree.
    const byId = new Map(categories.map((c) => [c.id, { ...c, children: [] as unknown[] }]));
    const roots: unknown[] = [];
    for (const category of byId.values()) {
      const parent = category.parentId ? byId.get(category.parentId) : undefined;
      if (parent) parent.children.push(category);
      else roots.push(category);
    }
    return roots;
  }

  async createCategory(actorUserId: string, data: Record<string, unknown>) {
    if (data.parentId) {
      // Loading through the guarded client is what stops a parent from another tenant.
      await this.prisma.client.category.findFirstOrThrow({ where: { id: data.parentId as string } });
    }
    const category = await this.prisma.client.category.create({ data: data as never });
    await this.audit.record({
      actorUserId, action: 'category.created', entityType: 'CATEGORY', entityId: category.id,
    });
    return category;
  }

  async updateCategory(actorUserId: string, id: string, data: Record<string, unknown>) {
    if (data.parentId === id) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'A category cannot be its own parent');
    }
    const category = await this.prisma.client.category.update({ where: { id }, data: data as never });
    await this.audit.record({
      actorUserId, action: 'category.updated', entityType: 'CATEGORY', entityId: id,
    });
    return category;
  }

  async deleteCategory(actorUserId: string, id: string) {
    const productCount = await this.prisma.client.product.count({ where: { categoryId: id } });
    if (productCount > 0) {
      // Deleting would orphan products silently; making the owner move them is the
      // honest behaviour.
      throw new DomainError(ErrorCode.CONFLICT, 'Move or delete the products in this category first', {
        productCount,
      });
    }
    await this.prisma.client.category.delete({ where: { id } });
    await this.audit.record({
      actorUserId, action: 'category.deleted', entityType: 'CATEGORY', entityId: id,
    });
  }

  // ── products ─────────────────────────────────────────────────────────────────

  async listProducts(query: {
    page?: number; pageSize?: number; search?: string; categoryId?: string;
    isActive?: boolean; isFeatured?: boolean; lowStock?: boolean;
    sortBy?: string; sortOrder?: 'asc' | 'desc';
  }) {
    const page = normalizePageParams(query);
    const where: Prisma.ProductWhereInput = { archivedAt: null };

    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.isFeatured !== undefined) where.isFeatured = query.isFeatured;
    if (query.search) {
      // Search across the translated name JSON and the SKU. Postgres trigram indexes
      // back this; a dedicated search service is a later problem (risk watch list).
      where.OR = [
        { name: { path: ['uz'], string_contains: query.search } },
        { name: { path: ['ru'], string_contains: query.search } },
        { sku: { contains: query.search, mode: 'insensitive' } },
        { barcode: { contains: query.search } },
      ];
    }

    const orderBy = this.productOrderBy(query.sortBy, query.sortOrder);

    const [items, total] = await Promise.all([
      this.prisma.client.product.findMany({
        where, orderBy, ...toSkipTake(page),
        include: {
          category: { select: { id: true, name: true } },
          variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          _count: { select: { variants: true } },
        },
      }),
      this.prisma.client.product.count({ where }),
    ]);

    // Low stock is a computed condition over both the product and its variants, so it is
    // applied after loading rather than expressed as a fragile SQL predicate.
    const filtered = query.lowStock
      ? items.filter((p) => p.trackInventory && p.lowStockThreshold !== null &&
          this.effectiveStock(p) <= p.lowStockThreshold)
      : items;

    return paginate(filtered.map((p) => this.presentProduct(p)), total, page);
  }

  async getProduct(id: string) {
    const product = await this.prisma.client.product.findFirst({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        variants: { orderBy: { sortOrder: 'asc' } },
        modifierGroups: {
          include: { group: { include: { options: { orderBy: { sortOrder: 'asc' } } } } },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!product) throw new DomainError(ErrorCode.NOT_FOUND, 'Product not found');
    return this.presentProduct(product);
  }

  async createProduct(actorUserId: string, input: Record<string, unknown>) {
    const { modifierGroupIds, ...data } = input as { modifierGroupIds?: string[] } & Record<string, unknown>;

    if (data.categoryId) {
      await this.prisma.client.category.findFirstOrThrow({ where: { id: data.categoryId as string } });
    }
    if (modifierGroupIds?.length) await this.assertModifierGroupsExist(modifierGroupIds);

    const product = await this.prisma.client.product.create({
      data: {
        ...(data as Record<string, unknown>),
        ...(modifierGroupIds?.length
          ? {
              modifierGroups: {
                create: modifierGroupIds.map((groupId, i) => ({
                  groupId,
                  sortOrder: i,
                  tenant: undefined as never,
                  tenantId: undefined as never,
                })),
              },
            }
          : {}),
      } as never,
    });

    await this.audit.record({
      actorUserId, action: 'product.created', entityType: 'PRODUCT', entityId: product.id,
      after: { name: product.name, price: product.price },
    });
    return this.getProduct(product.id);
  }

  async updateProduct(actorUserId: string, id: string, input: Record<string, unknown>) {
    const { modifierGroupIds, ...data } = input as { modifierGroupIds?: string[] } & Record<string, unknown>;
    const before = await this.prisma.client.product.findFirstOrThrow({ where: { id } });

    if (data.categoryId) {
      await this.prisma.client.category.findFirstOrThrow({ where: { id: data.categoryId as string } });
    }

    const after = await this.prisma.client.product.update({ where: { id }, data: data as never });

    if (modifierGroupIds) {
      await this.assertModifierGroupsExist(modifierGroupIds);
      await this.prisma.client.productModifierGroup.deleteMany({ where: { productId: id } });
      if (modifierGroupIds.length > 0) {
        await this.prisma.client.productModifierGroup.createMany({
          data: modifierGroupIds.map((groupId, i) => ({ productId: id, groupId, sortOrder: i })) as never,
        });
      }
    }

    // A price change is audited explicitly: it is the field most likely to be queried
    // after a customer dispute.
    await this.audit.recordChange(
      { actorUserId, action: 'product.updated', entityType: 'PRODUCT', entityId: id },
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    return this.getProduct(id);
  }

  /**
   * Archive rather than delete. Order items keep a snapshot, so history survives either
   * way, but a hard delete also destroys inventory history and analytics attribution.
   */
  async archiveProduct(actorUserId: string, id: string) {
    await this.prisma.client.product.update({
      where: { id },
      data: { archivedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      actorUserId, action: 'product.archived', entityType: 'PRODUCT', entityId: id,
    });
  }

  // ── variants ─────────────────────────────────────────────────────────────────

  async createVariant(productId: string, data: Record<string, unknown>) {
    await this.prisma.client.product.findFirstOrThrow({ where: { id: productId } });
    return this.prisma.client.productVariant.create({
      data: { ...(data as Record<string, unknown>), productId } as never,
    });
  }

  async updateVariant(id: string, data: Record<string, unknown>) {
    return this.prisma.client.productVariant.update({ where: { id }, data: data as never });
  }

  async deleteVariant(id: string) {
    await this.prisma.client.productVariant.delete({ where: { id } });
  }

  // ── modifier groups ──────────────────────────────────────────────────────────

  async listModifierGroups() {
    return this.prisma.client.modifierGroup.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } }, _count: { select: { products: true } } },
    });
  }

  async createModifierGroup(data: { options: Record<string, unknown>[] } & Record<string, unknown>) {
    const { options, ...group } = data;
    return this.prisma.client.modifierGroup.create({
      data: { ...(group as Record<string, unknown>), options: { create: options } } as never,
      include: { options: true },
    });
  }

  async updateModifierGroup(id: string, data: { options?: Record<string, unknown>[] } & Record<string, unknown>) {
    const { options, ...group } = data;
    await this.prisma.client.modifierGroup.update({
      where: { id }, data: group as Record<string, unknown> as never,
    });

    if (options) {
      // Replace wholesale: option ids are not stable across an edit in the UI, and
      // diffing them would be guesswork. Existing orders keep their snapshots.
      await this.prisma.client.modifierOption.deleteMany({ where: { groupId: id } });
      await this.prisma.client.modifierOption.createMany({
        data: options.map((o, i) => ({ ...o, groupId: id, sortOrder: i })) as never,
      });
    }
    return this.prisma.client.modifierGroup.findFirstOrThrow({
      where: { id }, include: { options: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async deleteModifierGroup(id: string) {
    await this.prisma.client.modifierGroup.delete({ where: { id } });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async assertModifierGroupsExist(ids: string[]) {
    const found = await this.prisma.client.modifierGroup.count({ where: { id: { in: ids } } });
    if (found !== ids.length) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'One or more modifier groups do not exist');
    }
  }

  private productOrderBy(sortBy?: string, sortOrder: 'asc' | 'desc' = 'asc'): Prisma.ProductOrderByWithRelationInput {
    // An allow-list, not a pass-through: letting a client name any column is both a
    // query-plan hazard and a way to probe the schema.
    switch (sortBy) {
      case 'price': return { price: sortOrder };
      case 'createdAt': return { createdAt: sortOrder };
      case 'stockQuantity': return { stockQuantity: sortOrder };
      case 'name': return { createdAt: sortOrder }; // JSON name cannot be ordered usefully
      default: return { sortOrder };
    }
  }

  private effectiveStock(product: { stockQuantity: number; variants?: { stockQuantity: number }[] }) {
    // With variants, the product-level number is meaningless — stock lives on variants.
    if (product.variants?.length) {
      return product.variants.reduce((sum, v) => sum + v.stockQuantity, 0);
    }
    return product.stockQuantity;
  }

  private presentProduct(product: Record<string, unknown> & {
    variants?: { stockQuantity: number }[];
    stockQuantity: number; trackInventory: boolean; lowStockThreshold: number | null;
    modifierGroups?: { group: unknown }[];
  }) {
    const stock = this.effectiveStock(product as never);
    return {
      ...product,
      effectiveStock: stock,
      isLowStock:
        product.trackInventory &&
        product.lowStockThreshold !== null &&
        stock <= product.lowStockThreshold,
      isOutOfStock: product.trackInventory && stock <= 0,
      modifierGroups: product.modifierGroups?.map((link) => link.group),
    };
  }
}

export type { I18nValue };
