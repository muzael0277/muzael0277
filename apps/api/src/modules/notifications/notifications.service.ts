import { Injectable } from '@nestjs/common';
import { formatMoney, resolveI18n, type Language } from '@bizbot/shared';
import { t } from '@bizbot/i18n';
import { PrismaService } from '../../infra/prisma.service';
import { TelegramSender } from '../telegram/telegram-sender.service';
import { logger } from '../../common/logger';

/**
 * Notifications.
 *
 * Channel-agnostic by construction: a template plus variables in, a rendered message out.
 * Telegram is the only channel today, and SMS or email become an adapter rather than a
 * rewrite. Tenants can override any template; the platform default is the fallback so a
 * business that has customized nothing still sends sensible messages.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramSender,
  ) {}

  /**
   * Renders and sends immediately. Called from event handlers on the worker, where a
   * slow Telegram call cannot stall an HTTP request.
   */
  async send(input: {
    tenantId: string;
    customerId: string;
    templateKey: string;
    variables: Record<string, string | number>;
    bookingId?: string;
    scheduledFor?: Date;
  }): Promise<void> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: input.customerId },
      select: { id: true, language: true, botBlocked: true, telegramUserId: true },
    });
    if (!customer) return;

    // Nothing to do for a customer who is unreachable; recording it as SKIPPED keeps the
    // difference between "never tried" and "cannot deliver" visible in the log.
    if (customer.botBlocked || !customer.telegramUserId) {
      await this.record(input, null, 'SKIPPED', 'Customer is unreachable on Telegram');
      return;
    }

    const language = (customer.language as Language) ?? 'uz';
    const body = await this.render(input.templateKey, language, input.variables);
    if (!body) {
      logger.warn({ templateKey: input.templateKey }, 'No notification template found');
      return;
    }

    const notification = await this.record(input, body, 'QUEUED');

    const result = await this.telegram.sendToCustomer(input.tenantId, input.customerId, body);

    await this.prisma.client.notification.update({
      where: { id: notification.id },
      data: result.delivered
        ? { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } }
        : { status: 'FAILED', failureReason: result.reason, attempts: { increment: 1 } },
    });
  }

  /**
   * Renders a template.
   *
   * Tenant override first, then the platform default from the i18n dictionary — so a new
   * template key works everywhere the moment it is added, without a per-tenant migration.
   */
  async render(
    templateKey: string,
    language: Language,
    variables: Record<string, string | number>,
  ): Promise<string | null> {
    const custom = await this.prisma.client.notificationTemplate.findFirst({
      where: { key: templateKey, channel: 'TELEGRAM', isActive: true },
    });

    const template = custom
      ? resolveI18n(custom.body as never, language)
      : t(language, `bot.${toCamel(templateKey)}`);

    // t() returns the key when there is no translation; that is not a message to send.
    if (!template || template.startsWith('bot.')) return null;

    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      name in variables ? String(variables[name]) : `{{${name}}}`,
    );
  }

  /** Formats a money variable in the tenant's currency and the customer's language. */
  money(amount: number, currency: string, language: Language): string {
    return formatMoney(amount, currency as never, language);
  }

  private async record(
    input: {
      tenantId: string;
      customerId: string;
      templateKey: string;
      variables: Record<string, string | number>;
      bookingId?: string;
      scheduledFor?: Date;
    },
    body: string | null,
    status: 'QUEUED' | 'SKIPPED',
    failureReason?: string,
  ) {
    return this.prisma.client.notification.create({
      data: {
        customerId: input.customerId,
        bookingId: input.bookingId ?? null,
        channel: 'TELEGRAM',
        templateKey: input.templateKey,
        payload: input.variables as never,
        renderedBody: body,
        status,
        failureReason,
        scheduledFor: input.scheduledFor ?? new Date(),
      } as never,
    });
  }
}

/** ORDER_CREATED -> orderCreated, matching the i18n dictionary's key style. */
function toCamel(key: string): string {
  return key.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
