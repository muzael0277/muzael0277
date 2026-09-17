import { Injectable } from '@nestjs/common';
import { Prisma, type GuardedTransactionClient, type OrderStatus } from '@bizbot/database';
import {
  DomainError, ErrorCode, formatOrderNumber, normalizePageParams, paginate, toSkipTake,
} from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { CartService, type CartLine } from '../cart/cart.service';
import { EventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/event-types';
import { AuditService } from '../audit/audit.service';

/**
 * Orders.
 *
 * Checkout recomputes everything from the catalog (invariant I2) and writes the order,
 * its snapshots, the promo usage, the loyalty spend, the stock movements and the domain
 * event in one transaction. Either the customer has an order and the stock is reserved,
 * or nothing happened — there is no state where a cart was charged but the order is
 * missing.
 */

const DEFAULT_PIPELINE: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELLED'],
  PREPARING: ['READY', 'DELIVERING', 'COMPLETED', 'CANCELLED'],
  READY: ['DELIVERING', 'COMPLETED', 'CANCELLED'],
  DELIVERING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  // ── checkout ─────────────────────────────────────────────────────────────────

  async checkout(
    customerId: string,
    input: {
      fulfillmentType: 'DELIVERY' | 'PICKUP' | 'DINE_IN';
      branchId?: string;
      addressId?: string;
      address?: { line1: string; landmark?: string; latitude?: number; longitude?: number; label?: string; saveForLater?: boolean };
      phone?: string;
      paymentMethod: string;
      promoCode?: string;
      useLoyaltyAmount?: number;
      comment?: string;
      scheduledFor?: string;
    },
  ) {
    const cart = await this.cart.getOrCreate(customerId);
    if (cart.items.length === 0) throw new DomainError(ErrorCode.CART_EMPTY);

    const promoCode = input.promoCode ?? cart.promoCode;
    // The authoritative price. Whatever the client displayed is irrelevant here.
    const pricing = await this.cart.resolvePricing({
      lines: cart.items as unknown as CartLine[],
      customerId,
      promoCode,
      fulfillmentType: input.fulfillmentType,
      loyaltySpend: input.useLoyaltyAmount ?? 0,
    });

    const [tenant, customer] = await Promise.all([
      this.prisma.client.tenant.findFirstOrThrow(),
      this.prisma.client.customer.findFirstOrThrow({ where: { id: customerId } }),
    ]);

    const address = await this.resolveAddress(customerId, input);
    const promo = promoCode ? await this.cart.resolvePromo(promoCode, customerId) : null;

    const order = await this.prisma.client.$transaction(async (tx) => {
      const orderNumber = await this.nextOrderNumber(tx, tenant.id);

      const created = await tx.order.create({
        data: {
          tenantId: tenant.id,
          orderNumber,
          customerId,
          branchId: input.branchId ?? null,
          addressId: address?.id ?? null,
          status: 'NEW',
          fulfillmentType: input.fulfillmentType,
          paymentStatus: 'UNPAID',
          paymentMethod: input.paymentMethod as never,
          subtotal: pricing.subtotal,
          discountTotal: pricing.discountTotal,
          promoDiscount: pricing.promoDiscount,
          loyaltyDiscount: pricing.loyaltyDiscount,
          deliveryFee: pricing.deliveryFee,
          taxTotal: pricing.taxTotal,
          total: pricing.total,
          currency: tenant.currency,
          promoCodeId: promo?.id ?? null,
          loyaltyEarned: pricing.loyaltyEarn,
          customerComment: input.comment,
          addressSnapshot: address ? `${address.line1}${address.landmark ? `, ${address.landmark}` : ''}` : null,
          phoneSnapshot: input.phone ?? customer.phone,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
          source: 'MINIAPP',
          items: {
            // Snapshots: name, price and modifiers are copied now so a later price change
            // or a deleted product cannot rewrite what was sold (invariant I6).
            create: pricing.lines.map((line) => ({
              tenantId: tenant.id,
              productId: line.productId,
              variantId: line.variantId ?? null,
              nameSnapshot: line.nameSnapshot as Prisma.InputJsonValue,
              variantNameSnapshot: (line.variantNameSnapshot ?? null) as Prisma.InputJsonValue,
              skuSnapshot: line.skuSnapshot ?? null,
              unitPrice: line.effectiveUnitPrice,
              modifiersPrice: line.modifiersPrice,
              quantity: line.quantity,
              discount: line.discount,
              total: line.total,
              comment: line.comment,
              modifiers: {
                create: line.modifiers.map((m) => ({
                  tenantId: tenant.id,
                  optionId: m.optionId,
                  nameSnapshot: m.name as Prisma.InputJsonValue,
                  price: m.price,
                })),
              },
            })),
          },
          statusHistory: { create: { tenantId: tenant.id, toStatus: 'NEW' } },
        },
        include: { items: true },
      });

      // Promo usage is unique on (orderId, promoCodeId), so a retry cannot consume the
      // code twice.
      if (promo && pricing.promoDiscount > 0) {
        await tx.promoUsage.create({
          data: {
            tenantId: tenant.id, promoCodeId: promo.id, customerId,
            orderId: created.id, discount: pricing.promoDiscount,
          },
        });
        await tx.promoCode.update({
          where: { id: promo.id }, data: { usageCount: { increment: 1 } },
        });
        await this.events.emit(tx, DomainEventType.PROMO_USED, { type: 'ORDER', id: created.id }, {
          promoCodeId: promo.id, code: promo.code, customerId,
          orderId: created.id, discount: pricing.promoDiscount,
        });
      }

      if (pricing.loyaltyDiscount > 0) {
        await this.spendLoyalty(tx, tenant.id, customerId, pricing.loyaltyDiscount, created.id);
      }

      await this.reserveStock(tx, tenant.id, created.id, cart.items as unknown as CartLine[]);

      await tx.customer.update({
        where: { id: customerId },
        data: {
          orderCount: { increment: 1 },
          lastActivityAt: new Date(),
          ...(input.phone && !customer.phone ? { phone: input.phone } : {}),
        },
      });

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { promoCode: null } });

      await this.events.emit(tx, DomainEventType.ORDER_CREATED, { type: 'ORDER', id: created.id }, {
        orderId: created.id, orderNumber, customerId, total: pricing.total,
      });

      return created;
    }, { timeout: 15_000 });

    return this.detail(order.id);
  }

  /** Staff-created order (phone order, walk-in). Same pricing path as the Mini App. */
  async createByStaff(
    actorUserId: string,
    input: {
      customerId?: string; customerPhone?: string; customerName?: string;
      branchId?: string; fulfillmentType: 'DELIVERY' | 'PICKUP' | 'DINE_IN';
      items: { productId: string; variantId?: string | null; quantity: number; modifierOptionIds: string[]; comment?: string }[];
      paymentMethod: string; promoCode?: string; comment?: string; internalComment?: string;
      address?: { line1: string; landmark?: string };
    },
  ) {
    const customer = await this.resolveStaffCustomer(input);

    // Reuse the customer's cart machinery so pricing, stock and modifier validation are
    // identical to the Mini App path. Two code paths would mean two sets of bugs.
    await this.cart.clear(customer.id);
    for (const item of input.items) {
      await this.cart.addItem(customer.id, {
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        modifierOptionIds: item.modifierOptionIds ?? [],
        comment: item.comment,
      });
    }

    const order = await this.checkout(customer.id, {
      fulfillmentType: input.fulfillmentType,
      branchId: input.branchId,
      address: input.address,
      paymentMethod: input.paymentMethod,
      promoCode: input.promoCode,
      comment: input.comment,
    });

    await this.prisma.client.order.update({
      where: { id: order.id },
      data: { internalComment: input.internalComment, source: 'ADMIN' },
    });
    await this.audit.record({
      actorUserId, action: 'order.created_by_staff', entityType: 'ORDER', entityId: order.id,
    });
    return this.detail(order.id);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async updateStatus(id: string, next: OrderStatus, actor: { userId?: string }, comment?: string) {
    const order = await this.prisma.client.order.findFirstOrThrow({
      where: { id }, include: { items: true },
    });

    const allowed = DEFAULT_PIPELINE[order.status];
    if (!allowed.includes(next)) {
      throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, undefined, {
        from: order.status, to: next, allowed,
      });
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: {
          status: next,
          version: { increment: 1 },
          acceptedAt: next === 'ACCEPTED' ? new Date() : undefined,
          completedAt: next === 'COMPLETED' ? new Date() : undefined,
          cancelledAt: next === 'CANCELLED' ? new Date() : undefined,
          cancelReason: next === 'CANCELLED' ? comment : undefined,
          statusHistory: {
            create: {
              tenantId: order.tenantId, fromStatus: order.status, toStatus: next,
              changedById: actor.userId ?? null, comment,
            },
          },
        },
      });

      if (next === 'CANCELLED') {
        // Put the stock back. Without this, a cancelled order quietly shrinks inventory.
        await this.releaseStock(tx, order.tenantId, order.id);
        await this.events.emit(tx, DomainEventType.ORDER_CANCELLED, { type: 'ORDER', id }, {
          orderId: id, orderNumber: order.orderNumber, customerId: order.customerId, reason: comment,
        });
      } else if (next === 'COMPLETED') {
        await tx.customer.update({
          where: { id: order.customerId },
          data: { totalSpent: { increment: BigInt(order.total) } },
        });
        await this.events.emit(tx, DomainEventType.ORDER_COMPLETED, { type: 'ORDER', id }, {
          orderId: id, orderNumber: order.orderNumber, customerId: order.customerId, total: order.total,
        });
      }

      await this.events.emit(tx, DomainEventType.ORDER_STATUS_CHANGED, { type: 'ORDER', id }, {
        orderId: id, orderNumber: order.orderNumber, customerId: order.customerId,
        from: order.status, to: next,
      });

      return result;
    });

    await this.audit.record({
      tenantId: order.tenantId, actorUserId: actor.userId, action: 'order.status_changed',
      entityType: 'ORDER', entityId: id,
      before: { status: order.status }, after: { status: next },
    });
    return updated;
  }

  // ── queries ──────────────────────────────────────────────────────────────────

  async list(query: Record<string, unknown>) {
    const page = normalizePageParams(query as { page?: number; pageSize?: number });
    const where: Prisma.OrderWhereInput = {};

    if (query.status) {
      where.status = Array.isArray(query.status)
        ? { in: query.status as OrderStatus[] } : (query.status as OrderStatus);
    }
    if (query.customerId) where.customerId = query.customerId as string;
    if (query.branchId) where.branchId = query.branchId as string;
    if (query.fulfillmentType) where.fulfillmentType = query.fulfillmentType as never;
    if (query.paymentStatus) where.paymentStatus = query.paymentStatus as never;
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search as string, mode: 'insensitive' } },
        { phoneSnapshot: { contains: query.search as string } },
        { customer: { firstName: { contains: query.search as string, mode: 'insensitive' } } },
      ];
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom ? { gte: new Date(`${query.dateFrom as string}T00:00:00Z`) } : {}),
        ...(query.dateTo ? { lte: new Date(`${query.dateTo as string}T23:59:59Z`) } : {}),
      };
    }

    const sortBy = ['createdAt', 'total', 'orderNumber'].includes(String(query.sortBy))
      ? String(query.sortBy) : 'createdAt';

    const [items, total] = await Promise.all([
      this.prisma.client.order.findMany({
        where,
        orderBy: { [sortBy]: query.sortOrder ?? 'desc' } as never,
        ...toSkipTake(page),
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true, telegramUsername: true } },
          branch: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.client.order.count({ where }),
    ]);
    return paginate(items, total, page);
  }

  async detail(id: string) {
    return this.prisma.client.order.findFirstOrThrow({
      where: { id },
      include: {
        customer: true,
        branch: true,
        address: true,
        items: { include: { modifiers: true } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * Per-tenant, per-day sequence. An upsert with an atomic increment, so two concurrent
   * checkouts cannot receive the same number even under load.
   */
  private async nextOrderNumber(tx: GuardedTransactionClient, tenantId: string): Promise<string> {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const sequence = await tx.orderSequence.upsert({
      where: { tenantId_day: { tenantId, day } },
      create: { tenantId, day, value: 1 },
      update: { value: { increment: 1 } },
    });
    return formatOrderNumber(day, sequence.value);
  }

  private async spendLoyalty(
    tx: GuardedTransactionClient,
    tenantId: string,
    customerId: string,
    amount: number,
    orderId: string,
  ) {
    const account = await tx.loyaltyAccount.findUnique({ where: { customerId } });
    if (!account || account.balance < amount) {
      throw new DomainError(ErrorCode.INSUFFICIENT_LOYALTY_BALANCE, undefined, {
        available: account?.balance ?? 0, requested: amount,
      });
    }

    const balanceAfter = account.balance - amount;
    // Ledger row and balance in the same transaction — invariant I5.
    await tx.loyaltyTransaction.create({
      data: {
        tenantId, accountId: account.id, orderId, type: 'SPEND',
        amount: -amount, balanceAfter, reason: 'Buyurtmada ishlatildi',
      },
    });
    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { balance: balanceAfter, lifetimeSpent: { increment: BigInt(amount) } },
    });
    await tx.customer.update({ where: { id: customerId }, data: { loyaltyBalance: balanceAfter } });

    await this.events.emit(tx, DomainEventType.LOYALTY_SPENT, { type: 'CUSTOMER', id: customerId }, {
      customerId, amount, balance: balanceAfter, orderId,
    });
  }

  private async reserveStock(
    tx: GuardedTransactionClient,
    tenantId: string,
    orderId: string,
    lines: CartLine[],
  ) {
    for (const line of lines) {
      const product = await tx.product.findUnique({
        where: { id: line.productId },
        select: { id: true, trackInventory: true, stockQuantity: true, lowStockThreshold: true },
      });
      if (!product?.trackInventory) continue;

      if (line.variantId) {
        const variant = await tx.productVariant.findUnique({
          where: { id: line.variantId }, select: { stockQuantity: true },
        });
        const after = (variant?.stockQuantity ?? 0) - line.quantity;
        if (after < 0) {
          throw new DomainError(ErrorCode.INSUFFICIENT_STOCK, undefined, {
            productId: line.productId, available: variant?.stockQuantity ?? 0, requested: line.quantity,
          });
        }
        await tx.productVariant.update({
          where: { id: line.variantId }, data: { stockQuantity: after },
        });
        await tx.inventoryTransaction.create({
          data: {
            tenantId, productId: line.productId, variantId: line.variantId, orderId,
            type: 'SALE', quantity: -line.quantity, quantityAfter: after,
          },
        });
      } else {
        const after = product.stockQuantity - line.quantity;
        if (after < 0) {
          throw new DomainError(ErrorCode.INSUFFICIENT_STOCK, undefined, {
            productId: line.productId, available: product.stockQuantity, requested: line.quantity,
          });
        }
        await tx.product.update({ where: { id: product.id }, data: { stockQuantity: after } });
        await tx.inventoryTransaction.create({
          data: {
            tenantId, productId: line.productId, orderId,
            type: 'SALE', quantity: -line.quantity, quantityAfter: after,
          },
        });
        if (product.lowStockThreshold !== null && after <= product.lowStockThreshold) {
          await this.events.emit(tx, DomainEventType.INVENTORY_LOW, { type: 'PRODUCT', id: product.id }, {
            productId: product.id, stockQuantity: after, threshold: product.lowStockThreshold,
          });
        }
      }
    }
  }

  /** Reverses the SALE rows for a cancelled order, as RETURN rows — the ledger is append-only. */
  private async releaseStock(tx: GuardedTransactionClient, tenantId: string, orderId: string) {
    const movements = await tx.inventoryTransaction.findMany({
      where: { orderId, type: 'SALE' },
    });

    for (const movement of movements) {
      const quantity = Math.abs(movement.quantity);
      if (movement.variantId) {
        const variant = await tx.productVariant.update({
          where: { id: movement.variantId }, data: { stockQuantity: { increment: quantity } },
        });
        await tx.inventoryTransaction.create({
          data: {
            tenantId, productId: movement.productId, variantId: movement.variantId, orderId,
            type: 'RETURN', quantity, quantityAfter: variant.stockQuantity,
            reason: 'Buyurtma bekor qilindi',
          },
        });
      } else {
        const product = await tx.product.update({
          where: { id: movement.productId }, data: { stockQuantity: { increment: quantity } },
        });
        await tx.inventoryTransaction.create({
          data: {
            tenantId, productId: movement.productId, orderId,
            type: 'RETURN', quantity, quantityAfter: product.stockQuantity,
            reason: 'Buyurtma bekor qilindi',
          },
        });
      }
    }
  }

  private async resolveAddress(
    customerId: string,
    input: { addressId?: string; address?: { line1: string; landmark?: string; latitude?: number; longitude?: number; label?: string; saveForLater?: boolean }; fulfillmentType: string },
  ) {
    if (input.fulfillmentType !== 'DELIVERY') return null;

    if (input.addressId) {
      return this.prisma.client.customerAddress.findFirstOrThrow({
        where: { id: input.addressId, customerId },
      });
    }
    if (input.address) {
      if (input.address.saveForLater === false) {
        return { id: undefined, line1: input.address.line1, landmark: input.address.landmark } as never;
      }
      return this.prisma.client.customerAddress.create({
        data: {
          customerId,
          label: input.address.label,
          line1: input.address.line1,
          landmark: input.address.landmark,
          latitude: input.address.latitude,
          longitude: input.address.longitude,
        } as never,
      });
    }
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'A delivery address is required');
  }

  private async resolveStaffCustomer(input: { customerId?: string; customerPhone?: string; customerName?: string }) {
    if (input.customerId) {
      return this.prisma.client.customer.findFirstOrThrow({ where: { id: input.customerId } });
    }
    if (!input.customerPhone) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'A customer or phone number is required');
    }
    const existing = await this.prisma.client.customer.findFirst({ where: { phone: input.customerPhone } });
    if (existing) return existing;

    return this.prisma.client.customer.create({
      data: {
        firstName: input.customerName ?? 'Mijoz',
        phone: input.customerPhone,
        source: 'MANUAL',
        loyaltyAccount: { create: {} as never },
      } as never,
    });
  }
}
