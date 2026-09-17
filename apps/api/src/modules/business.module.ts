import { Module } from '@nestjs/common';

import { CatalogService } from './catalog/catalog.service';
import { ServicesService } from './catalog/services.service';
import { CatalogController, ServicesController } from './catalog/catalog.controller';
import { CustomersService } from './crm/customers.service';
import { CrmController } from './crm/crm.controller';
import { CartService } from './cart/cart.service';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';
import { BookingsService } from './bookings/bookings.service';
import { BookingsController } from './bookings/bookings.controller';
import { LoyaltyService } from './loyalty/loyalty.service';
import { AnalyticsService } from './analytics/analytics.service';
import { AnalyticsController } from './analytics/analytics.controller';
import { BranchesService } from './branches/branches.service';
import { BranchesController, EmployeesController } from './branches/branches.controller';
import { ShopController } from './shop/shop.controller';

/**
 * The business domains.
 *
 * Grouped in one Nest module because they share a request lifecycle and a transaction
 * boundary; the *code* boundaries that matter are enforced by the folder layout and the
 * rule that a domain may import another domain's service, never its repository
 * (docs/architecture/11-project-structure.md).
 */
@Module({
  providers: [
    CatalogService, ServicesService, CustomersService, CartService,
    OrdersService, BookingsService, LoyaltyService, AnalyticsService, BranchesService,
  ],
  controllers: [
    CatalogController, ServicesController, CrmController, OrdersController,
    BookingsController, AnalyticsController, BranchesController, EmployeesController,
    ShopController,
  ],
  exports: [
    CatalogService, CustomersService, CartService, OrdersService,
    BookingsService, LoyaltyService, AnalyticsService,
  ],
})
export class BusinessModule {}
