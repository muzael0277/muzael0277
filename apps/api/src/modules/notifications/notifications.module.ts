import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { BusinessModule } from '../business.module';
import { NotificationsService } from './notifications.service';
import { PaymentsService } from '../payments/payments.service';
import {
  PaymentWebhookController, CustomerPaymentsController, PaymentsAdminController,
} from '../payments/payments.controller';
import { TimelineProjector } from '../events/handlers/timeline.handler';
import { LoyaltyAccrualHandler } from '../events/handlers/loyalty-accrual.handler';
import { NotificationHandler } from '../events/handlers/notification.handler';
import { BookingReminderProcessor } from './booking-reminder.processor';
import { IntegrationsService } from '../integrations/integrations.service';
import { IntegrationsController } from '../integrations/integrations.controller';

/**
 * Integrations: notifications, payments and the event handlers that connect them to the
 * business domains. Grouped here because they are all consumers of domain events rather
 * than owners of business rules.
 */
@Module({
  imports: [TelegramModule, BusinessModule],
  providers: [
    NotificationsService,
    PaymentsService,
    TimelineProjector,
    LoyaltyAccrualHandler,
    NotificationHandler,
    BookingReminderProcessor,
    IntegrationsService,
  ],
  controllers: [
    PaymentWebhookController, CustomerPaymentsController, PaymentsAdminController,
    IntegrationsController,
  ],
  exports: [NotificationsService, PaymentsService, IntegrationsService],
})
export class IntegrationsModule {}
