import { Injectable } from '@nestjs/common';
import { TelegramApiError } from '@bizbot/telegram';
import { PrismaService } from '../../infra/prisma.service';
import { TelegramBotService } from './telegram-bot.service';
import { logger } from '../../common/logger';

export interface SendResult {
  delivered: boolean;
  reason?: 'NO_BOT' | 'NO_CHAT' | 'BLOCKED' | 'RATE_LIMITED' | 'ERROR';
  retryAfterSeconds?: number;
}

/**
 * Outbound messages.
 *
 * Wraps the per-bot client with the failure handling the notification engine needs:
 * a customer who blocked the bot is recorded so we stop trying, and a 429 reports how
 * long to wait rather than being retried immediately — hammering Telegram is how a
 * tenant's bot gets throttled, which means their customers stop hearing from them.
 */
@Injectable()
export class TelegramSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: TelegramBotService,
  ) {}

  async sendToCustomer(
    tenantId: string,
    customerId: string,
    text: string,
    replyMarkup?: unknown,
  ): Promise<SendResult> {
    const customer = await this.prisma.system('sender-load-customer', () =>
      this.prisma.raw.customer.findUnique({
        where: { id: customerId },
        select: { telegramUserId: true, botBlocked: true },
      }),
    );

    if (!customer?.telegramUserId) return { delivered: false, reason: 'NO_CHAT' };
    if (customer.botBlocked) return { delivered: false, reason: 'BLOCKED' };

    const client = await this.bots.clientFor(tenantId);
    if (!client) return { delivered: false, reason: 'NO_BOT' };

    try {
      await client.sendMessage(Number(customer.telegramUserId), text, {
        reply_markup: replyMarkup as never,
      });
      return { delivered: true };
    } catch (error) {
      if (error instanceof TelegramApiError) {
        if (error.isBotBlocked) {
          await this.bots.markBotBlocked(tenantId, customerId);
          return { delivered: false, reason: 'BLOCKED' };
        }
        if (error.isRateLimited) {
          return {
            delivered: false,
            reason: 'RATE_LIMITED',
            retryAfterSeconds: error.retryAfterSeconds,
          };
        }
      }
      logger.error({ err: error, tenantId, customerId }, 'Telegram send failed');
      return { delivered: false, reason: 'ERROR' };
    }
  }
}
