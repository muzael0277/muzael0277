import { Injectable } from '@nestjs/common';
import type { Prisma } from '@bizbot/database';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { tenantContext } from '@bizbot/database';
import { PrismaService } from '../../infra/prisma.service';
import {
  PricingService,
  type PricingInput,
  type PricingLineInput,
  type PricingResult,
  type PromoRule,
} from './pricing.service';

/**
 * Cart and the pricing bridge.
 *
 * `resolvePricing` is the single place that turns *selections* into *money*. Both the
 * Mini App cart and a staff-created phone order go through it, so there is exactly one
 * implementation of what an order costs — two would drift, and the one that drifted
 * would be the one a customer disputes.
 */
@Injectable()
export class CartService {
  private readonly pricing = new PricingService();

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(customerId: string) {
    const existing = await this.prisma.client.cart.findFirst({
      where: { customerId },
      include: this.cartInclude(),
    });
    if (existing) return existing;

    await this.prisma.client.cart.create({ data: { customerId } as never });
    return this.prisma.client.cart.findFirstOrThrow({
      where: { customerId },
      include: this.cartInclude(),
    });
  }

  async addItem(
    customerId: string,
    input: {
      productId: string;
      variantId?: string | null;
      quantity: number;
      modifierOptionIds: string[];
      comment?: string;
    },
  ) {
    const cart = await this.getOrCreate(customerId);

    // Load through the guarded client so a product id from another tenant simply does
    // not exist, and validate the modifier selection before anything is written.
    const product = await this.prisma.client.product.findFirst({
      where: { id: input.productId, isActive: true, archivedAt: null },
      include: {
        variants: true,
        modifierGroups: { include: { group: { include: { options: true } } } },
      },
    });
    if (!product)
      throw new DomainError(ErrorCode.PRODUCT_UNAVAILABLE, undefined, {
        productId: input.productId,
      });

    if (input.variantId && !product.variants.some((v) => v.id === input.variantId && v.isActive)) {
      throw new DomainError(ErrorCode.PRODUCT_UNAVAILABLE, 'That option is not available', {
        variantId: input.variantId,
      });
    }

    this.assertModifierSelection(
      product.modifierGroups.map((l) => l.group),
      input.modifierOptionIds,
    );
    await this.assertStock(product, input.variantId ?? null, input.quantity);

    // Identical selections merge into one line, which is what a customer expects when
    // they tap "add" twice.
    const existing = cart.items.find(
      (item) =>
        item.productId === input.productId &&
        (item.variantId ?? null) === (input.variantId ?? null) &&
        sameModifierSet(
          item.modifiers.map((m) => m.optionId),
          input.modifierOptionIds,
        ),
    );

    if (existing) {
      await this.prisma.client.cartItem.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + input.quantity },
      });
    } else {
      // The tenant guard stamps the top-level row, but not nested creates. CartItemModifier
      // reaches ModifierOption through a composite (tenantId, optionId) foreign key — the
      // very constraint that blocks cross-tenant links — so the nested rows must carry the
      // tenant explicitly. Reading it from the request context rather than from the input
      // keeps that unforgeable.
      const tenantId = tenantContext.tenantId();
      if (!tenantId) throw new DomainError(ErrorCode.MISSING_TENANT_CONTEXT);

      await this.prisma.client.cartItem.create({
        data: {
          cartId: cart.id,
          productId: input.productId,
          variantId: input.variantId ?? null,
          quantity: input.quantity,
          comment: input.comment,
          modifiers: {
            create: input.modifierOptionIds.map((optionId) => ({ tenantId, optionId })),
          },
        } as never,
      });
    }

    return this.summary(customerId);
  }

  async updateItem(customerId: string, itemId: string, quantity: number) {
    const cart = await this.getOrCreate(customerId);
    const item = cart.items.find((i) => i.id === itemId);
    if (!item) throw new DomainError(ErrorCode.NOT_FOUND, 'Cart item not found');

    if (quantity === 0) {
      await this.prisma.client.cartItem.delete({ where: { id: itemId } });
    } else {
      await this.assertStock(
        await this.prisma.client.product.findFirstOrThrow({
          where: { id: item.productId },
          include: { variants: true },
        }),
        item.variantId,
        quantity,
      );
      await this.prisma.client.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }
    return this.summary(customerId);
  }

  async removeItem(customerId: string, itemId: string) {
    const cart = await this.getOrCreate(customerId);
    if (!cart.items.some((i) => i.id === itemId)) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Cart item not found');
    }
    await this.prisma.client.cartItem.delete({ where: { id: itemId } });
    return this.summary(customerId);
  }

  async clear(customerId: string) {
    const cart = await this.getOrCreate(customerId);
    await this.prisma.client.cartItem.deleteMany({ where: { cartId: cart.id } });
    await this.prisma.client.cart.update({ where: { id: cart.id }, data: { promoCode: null } });
    return this.summary(customerId);
  }

  async applyPromo(customerId: string, code: string) {
    const cart = await this.getOrCreate(customerId);
    // Validate now so the customer gets immediate feedback, and again at checkout so a
    // code that expires in between cannot slip through.
    await this.resolvePromo(code, customerId);
    await this.prisma.client.cart.update({ where: { id: cart.id }, data: { promoCode: code } });
    return this.summary(customerId);
  }

  async removePromo(customerId: string) {
    const cart = await this.getOrCreate(customerId);
    await this.prisma.client.cart.update({ where: { id: cart.id }, data: { promoCode: null } });
    return this.summary(customerId);
  }

  /** The priced cart the Mini App renders. Nothing here is taken from the client. */
  async summary(
    customerId: string,
    options: { fulfillmentType?: 'DELIVERY' | 'PICKUP' | 'DINE_IN'; loyaltySpend?: number } = {},
  ) {
    const cart = await this.getOrCreate(customerId);
    if (cart.items.length === 0) {
      return { cart: { id: cart.id, items: [], promoCode: null }, pricing: null };
    }

    const pricing = await this.resolvePricing({
      lines: cart.items,
      customerId,
      promoCode: cart.promoCode,
      fulfillmentType: options.fulfillmentType ?? 'DELIVERY',
      loyaltySpend: options.loyaltySpend ?? 0,
    });

    return {
      cart: {
        id: cart.id,
        promoCode: cart.promoCode,
        items: cart.items.map((item, i) => ({
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          name: item.product.name,
          variantName: item.variant?.name ?? null,
          imageUrl: item.product.images[0] ?? null,
          quantity: item.quantity,
          comment: item.comment,
          modifiers: item.modifiers.map((m) => ({
            optionId: m.optionId,
            name: m.option.name,
            price: m.option.price,
          })),
          unitPrice: pricing.lines[i]?.effectiveUnitPrice ?? 0,
          modifiersPrice: pricing.lines[i]?.modifiersPrice ?? 0,
          total: pricing.lines[i]?.total ?? 0,
        })),
      },
      pricing,
    };
  }

  /**
   * Turns cart rows (or a staff-entered item list) into a priced result.
   *
   * Every price is read from the catalog here. A price arriving in the request body is
   * never consulted — that is invariant I2, and it is why this function takes ids and
   * quantities only.
   */
  async resolvePricing(input: {
    lines: CartLine[];
    customerId: string;
    promoCode?: string | null;
    fulfillmentType: 'DELIVERY' | 'PICKUP' | 'DINE_IN';
    loyaltySpend: number;
  }): Promise<PricingResult> {
    const [tenant, loyaltyAccount] = await Promise.all([
      this.prisma.client.tenant.findFirstOrThrow({ include: { settings: true } }),
      this.prisma.client.loyaltyAccount.findFirst({ where: { customerId: input.customerId } }),
    ]);

    const settings = tenant.settings;
    const delivery = (settings?.deliverySettings ?? {}) as Record<string, number | boolean | null>;
    const loyalty = (settings?.loyaltySettings ?? {}) as Record<string, number | boolean>;

    const promo = input.promoCode
      ? await this.resolvePromo(input.promoCode, input.customerId)
      : null;

    const pricingLines: PricingLineInput[] = input.lines.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.product.price,
      variantPriceModifier: item.variant?.priceModifier ?? 0,
      modifiers: item.modifiers.map((m) => ({
        optionId: m.optionId,
        name: m.option.name,
        price: m.option.price,
      })),
      nameSnapshot: item.product.name,
      variantNameSnapshot: item.variant?.name ?? null,
      skuSnapshot: item.variant?.sku ?? item.product.sku,
      comment: item.comment ?? undefined,
    }));

    const pricingInput: PricingInput = {
      lines: pricingLines,
      fulfillmentType: input.fulfillmentType,
      promo,
      delivery: {
        enabled: delivery.enabled !== false,
        flatFee: Number(delivery.flatFee ?? 0),
        freeAbove:
          delivery.freeAbove === null || delivery.freeAbove === undefined
            ? null
            : Number(delivery.freeAbove),
        minOrderTotal: Number(delivery.minOrderTotal ?? 0),
      },
      loyalty: {
        enabled: loyalty.enabled === true,
        rate: Number(loyalty.rate ?? 0),
        minOrderTotal: Number(loyalty.minOrderTotal ?? 0),
        maxRedeemPercent: Number(loyalty.maxRedeemPercent ?? 50),
      },
      requestedLoyaltySpend: input.loyaltySpend,
      availableLoyaltyBalance: loyaltyAccount?.balance ?? 0,
    };

    return this.pricing.compute(pricingInput);
  }

  /** Validates a promo code against its window, limits and this customer's usage. */
  async resolvePromo(code: string, customerId: string): Promise<PromoRule> {
    const promo = await this.prisma.client.promoCode.findFirst({
      where: { code: code.toUpperCase() },
    });
    if (!promo || !promo.isActive)
      throw new DomainError(ErrorCode.PROMO_NOT_FOUND, undefined, { code });

    const now = new Date();
    if (promo.startsAt && promo.startsAt > now) {
      throw new DomainError(ErrorCode.PROMO_EXPIRED, 'This code is not active yet', {
        startsAt: promo.startsAt,
      });
    }
    if (promo.endsAt && promo.endsAt < now) {
      throw new DomainError(ErrorCode.PROMO_EXPIRED, undefined, { endsAt: promo.endsAt });
    }
    if (promo.usageLimit !== null && promo.usageCount >= promo.usageLimit) {
      throw new DomainError(ErrorCode.PROMO_USAGE_EXCEEDED);
    }
    if (promo.perCustomerLimit !== null) {
      const used = await this.prisma.client.promoUsage.count({
        where: { promoCodeId: promo.id, customerId },
      });
      if (used >= promo.perCustomerLimit) {
        throw new DomainError(ErrorCode.PROMO_USAGE_EXCEEDED, 'You have already used this code', {
          limit: promo.perCustomerLimit,
        });
      }
    }

    return {
      id: promo.id,
      code: promo.code,
      type: promo.type,
      value: promo.value,
      minOrderTotal: promo.minOrderTotal,
      maxDiscount: promo.maxDiscount,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private cartInclude() {
    return {
      items: {
        orderBy: { createdAt: 'asc' as const },
        include: {
          product: true,
          variant: true,
          modifiers: { include: { option: true } },
        },
      },
    };
  }

  /**
   * Enforces the group's min/max selection rules. Without this, a client could send an
   * empty selection for a required "choose a size" group, or three options for a group
   * that allows one — and the kitchen would receive an order it cannot make.
   */
  private assertModifierSelection(
    groups: {
      id: string;
      name: unknown;
      minSelect: number;
      maxSelect: number;
      options: { id: string }[];
    }[],
    selectedIds: string[],
  ) {
    const selected = new Set(selectedIds);
    const known = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));

    for (const id of selected) {
      if (!known.has(id)) {
        throw new DomainError(
          ErrorCode.MODIFIER_SELECTION_INVALID,
          'Unknown option for this product',
          {
            optionId: id,
          },
        );
      }
    }

    for (const group of groups) {
      const chosen = group.options.filter((o) => selected.has(o.id)).length;
      if (chosen < group.minSelect || chosen > group.maxSelect) {
        throw new DomainError(ErrorCode.MODIFIER_SELECTION_INVALID, undefined, {
          group: group.name,
          chosen,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
        });
      }
    }
  }

  private async assertStock(
    product: {
      id: string;
      trackInventory: boolean;
      stockQuantity: number;
      variants: { id: string; stockQuantity: number }[];
    },
    variantId: string | null,
    quantity: number,
  ) {
    if (!product.trackInventory) return;
    const available = variantId
      ? (product.variants.find((v) => v.id === variantId)?.stockQuantity ?? 0)
      : product.stockQuantity;
    if (available < quantity) {
      throw new DomainError(ErrorCode.INSUFFICIENT_STOCK, undefined, {
        available,
        requested: quantity,
      });
    }
  }
}

export interface CartLine {
  id?: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  comment?: string | null;
  product: { name: Prisma.JsonValue; price: number; sku: string | null; images: string[] };
  variant: { name: Prisma.JsonValue; priceModifier: number; sku: string | null } | null;
  modifiers: { optionId: string; option: { name: Prisma.JsonValue; price: number } }[];
}

function sameModifierSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
