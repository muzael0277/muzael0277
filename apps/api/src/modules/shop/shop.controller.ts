import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  addCartItemSchema,
  updateCartItemSchema,
  applyPromoSchema,
  checkoutSchema,
  availabilityQuerySchema,
  createBookingSchema,
  cancelBookingSchema,
} from '@bizbot/contracts';
import { resolveI18n, type Language } from '@bizbot/shared';
import { CurrentActor, CustomerRoute, Lang, RequireModule } from '../../common/decorators';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import type { RequestActor } from '../../common/types';
import { PrismaService } from '../../infra/prisma.service';
import { CartService } from '../cart/cart.service';
import { OrdersService } from '../orders/orders.service';
import { BookingsService } from '../bookings/bookings.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

/**
 * The Mini App surface.
 *
 * Every route here is authenticated by a *customer* session, and the tenant comes from
 * that signed token rather than from the request — a customer cannot point their session
 * at another business (docs/architecture/02-tenant-isolation.md).
 *
 * Responses are already localized to the customer's language, because a phone on mobile
 * data should not download three translations of every product name.
 */
@Controller('shop')
@CustomerRoute()
export class ShopController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly orders: OrdersService,
    private readonly bookings: BookingsService,
    private readonly loyalty: LoyaltyService,
  ) {}

  /** Everything the app needs to render its shell in one round trip. */
  @Get('bootstrap')
  async bootstrap(@CurrentActor() actor: RequestActor, @Lang() lang: Language) {
    const [tenant, customer, modules] = await Promise.all([
      this.prisma.client.tenant.findFirstOrThrow({ include: { settings: true } }),
      this.prisma.client.customer.findFirstOrThrow({
        where: { id: actor.customerId! },
        include: { loyaltyAccount: true, addresses: true },
      }),
      this.prisma.client.tenantModule.findMany({
        where: { enabled: true },
        select: { module: true },
      }),
    ]);

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
        currency: tenant.currency,
        timezone: tenant.timezone,
        templateKey: tenant.templateKey,
        description: resolveI18n(tenant.settings?.description as never, lang),
        phone: tenant.settings?.phone ?? null,
        workingHours: tenant.settings?.workingHours ?? {},
        delivery: tenant.settings?.deliverySettings ?? {},
        loyalty: tenant.settings?.loyaltySettings ?? {},
      },
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        language: customer.language,
        loyaltyBalance: customer.loyaltyAccount?.balance ?? 0,
        orderCount: customer.orderCount,
        bookingCount: customer.bookingCount,
        addresses: customer.addresses,
      },
      modules: modules.map((m) => m.module),
    };
  }

  // ── catalog ──────────────────────────────────────────────────────────────────

  @Get('catalog')
  @RequireModule('CATALOG')
  async catalog(@Lang() lang: Language, @Query('categoryId') categoryId?: string) {
    const [categories, products] = await Promise.all([
      this.prisma.client.category.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.client.product.findMany({
        where: {
          isActive: true,
          archivedAt: null,
          ...(categoryId ? { categoryId } : {}),
        },
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }],
        include: { variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
        take: 200,
      }),
    ]);

    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: resolveI18n(c.name as never, lang),
        imageUrl: c.imageUrl,
        parentId: c.parentId,
      })),
      products: products.map((p) => ({
        id: p.id,
        name: resolveI18n(p.name as never, lang),
        description: resolveI18n(p.description as never, lang),
        price: p.price,
        oldPrice: p.oldPrice,
        image: p.images[0] ?? null,
        categoryId: p.categoryId,
        isFeatured: p.isFeatured,
        // Out-of-stock items stay visible but unbuyable, so the menu does not shrink
        // mysteriously between visits.
        isAvailable: !p.trackInventory || this.hasStock(p),
        variants: p.variants.map((v) => ({
          id: v.id,
          name: resolveI18n(v.name as never, lang),
          priceModifier: v.priceModifier,
          isAvailable: v.stockQuantity > 0 || !p.trackInventory,
        })),
      })),
    };
  }

  @Get('catalog/:id')
  @RequireModule('CATALOG')
  async product(@Param('id') id: string, @Lang() lang: Language) {
    const product = await this.prisma.client.product.findFirstOrThrow({
      where: { id, isActive: true, archivedAt: null },
      include: {
        variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: {
            group: {
              include: { options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
            },
          },
        },
      },
    });

    return {
      id: product.id,
      name: resolveI18n(product.name as never, lang),
      description: resolveI18n(product.description as never, lang),
      price: product.price,
      oldPrice: product.oldPrice,
      images: product.images,
      isAvailable: !product.trackInventory || this.hasStock(product),
      variants: product.variants.map((v) => ({
        id: v.id,
        name: resolveI18n(v.name as never, lang),
        priceModifier: v.priceModifier,
        isAvailable: v.stockQuantity > 0 || !product.trackInventory,
      })),
      modifierGroups: product.modifierGroups.map((link) => ({
        id: link.group.id,
        name: resolveI18n(link.group.name as never, lang),
        minSelect: link.group.minSelect,
        maxSelect: link.group.maxSelect,
        options: link.group.options.map((o) => ({
          id: o.id,
          name: resolveI18n(o.name as never, lang),
          price: o.price,
          isDefault: o.isDefault,
        })),
      })),
    };
  }

  @Get('services')
  @RequireModule('SERVICES')
  async services(@Lang() lang: Language) {
    const services = await this.prisma.client.service.findMany({
      where: { isActive: true, archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { category: { select: { id: true, name: true } } },
    });
    return services.map((s) => ({
      id: s.id,
      name: resolveI18n(s.name as never, lang),
      description: resolveI18n(s.description as never, lang),
      price: s.price,
      durationMinutes: s.durationMinutes,
      imageUrl: s.imageUrl,
      category: s.category
        ? { id: s.category.id, name: resolveI18n(s.category.name as never, lang) }
        : null,
    }));
  }

  @Get('branches')
  async branches(@Lang() _lang: Language) {
    return this.prisma.client.branch.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        latitude: true,
        longitude: true,
        workingHours: true,
      },
    });
  }

  // ── cart ─────────────────────────────────────────────────────────────────────

  @Get('cart')
  @RequireModule('ORDERS')
  getCart(@CurrentActor() actor: RequestActor, @Query('fulfillmentType') fulfillmentType?: string) {
    return this.cart.summary(actor.customerId!, {
      fulfillmentType: (fulfillmentType as 'DELIVERY' | 'PICKUP' | 'DINE_IN') ?? 'DELIVERY',
    });
  }

  @Post('cart/items')
  @RequireModule('ORDERS')
  addItem(@CurrentActor() actor: RequestActor, @Body(zodBody(addCartItemSchema)) dto: never) {
    return this.cart.addItem(actor.customerId!, dto);
  }

  @Patch('cart/items/:id')
  @RequireModule('ORDERS')
  updateItem(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(updateCartItemSchema)) dto: { quantity: number },
  ) {
    return this.cart.updateItem(actor.customerId!, id, dto.quantity);
  }

  @Delete('cart/items/:id')
  @RequireModule('ORDERS')
  removeItem(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    return this.cart.removeItem(actor.customerId!, id);
  }

  @Post('cart/promo')
  @RequireModule('ORDERS')
  applyPromo(
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(applyPromoSchema)) dto: { code: string },
  ) {
    return this.cart.applyPromo(actor.customerId!, dto.code);
  }

  @Delete('cart/promo')
  @RequireModule('ORDERS')
  removePromo(@CurrentActor() actor: RequestActor) {
    return this.cart.removePromo(actor.customerId!);
  }

  @Post('checkout')
  @RequireModule('ORDERS')
  checkout(@CurrentActor() actor: RequestActor, @Body(zodBody(checkoutSchema)) dto: never) {
    return this.orders.checkout(actor.customerId!, dto);
  }

  // ── orders and bookings ──────────────────────────────────────────────────────

  @Get('orders')
  @RequireModule('ORDERS')
  myOrders(@CurrentActor() actor: RequestActor, @Query() query: Record<string, unknown>) {
    return this.orders.list({ ...query, customerId: actor.customerId });
  }

  @Get('orders/:id')
  @RequireModule('ORDERS')
  async myOrder(@CurrentActor() actor: RequestActor, @Param('id') id: string) {
    const order = await this.orders.detail(id);
    // A customer may only read their own order, even inside the right tenant.
    if (order.customerId !== actor.customerId) {
      return { error: { code: 'NOT_FOUND' } };
    }
    return order;
  }

  @Get('bookings/availability')
  @RequireModule('BOOKING')
  availability(@Query(zodQuery(availabilityQuerySchema)) query: never) {
    return this.bookings.getAvailability(query);
  }

  @Get('bookings')
  @RequireModule('BOOKING')
  myBookings(@CurrentActor() actor: RequestActor, @Query() query: Record<string, unknown>) {
    return this.bookings.list({ ...query, customerId: actor.customerId });
  }

  @Post('bookings')
  @RequireModule('BOOKING')
  book(@CurrentActor() actor: RequestActor, @Body(zodBody(createBookingSchema)) dto: never) {
    return this.bookings.create(dto, { customerId: actor.customerId });
  }

  @Post('bookings/:id/cancel')
  @RequireModule('BOOKING')
  cancelBooking(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body(zodBody(cancelBookingSchema)) dto: { reason?: string },
  ) {
    return this.bookings.cancelByCustomer(id, actor.customerId!, dto.reason);
  }

  @Get('loyalty')
  @RequireModule('LOYALTY')
  myLoyalty(
    @CurrentActor() actor: RequestActor,
    @Query() query: { page?: number; pageSize?: number },
  ) {
    return this.loyalty.transactions(actor.customerId!, query);
  }

  private hasStock(product: {
    stockQuantity: number;
    variants?: { stockQuantity: number }[];
  }): boolean {
    if (product.variants?.length) return product.variants.some((v) => v.stockQuantity > 0);
    return product.stockQuantity > 0;
  }
}
