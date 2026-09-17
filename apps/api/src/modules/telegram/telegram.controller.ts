import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { TgUpdate } from '@bizbot/telegram';
import { connectTelegramBotSchema, telegramAuthSchema } from '@bizbot/contracts';
import { tenantContext } from '@bizbot/database';
import { secureCompare } from '@bizbot/database';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentActor, Public, RequireModule, RequirePermission } from '../../common/decorators';
import type { RequestActor } from '../../common/types';
import { PrismaService } from '../../infra/prisma.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramAuthService } from './telegram-auth.service';
import { TelegramUpdateRouter } from './telegram-update.router';
import { logger } from '../../common/logger';

/**
 * The webhook gateway.
 *
 * @Public because no session exists when Telegram calls: authenticity comes from the
 * unguessable secret in the path plus the header token Telegram echoes back. The handler
 * resolves bot → tenant in system context, deduplicates, and only then enters a normal
 * tenant context (docs/architecture/07-telegram.md).
 */
@Controller('telegram')
export class TelegramGatewayController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: TelegramBotService,
    private readonly router: TelegramUpdateRouter,
  ) {}

  @Public()
  @Post('webhook/:secret')
  @HttpCode(200)
  async webhook(
    @Param('secret') secret: string,
    @Headers('x-telegram-bot-api-secret-token') headerToken: string | undefined,
    @Body() update: TgUpdate,
  ) {
    const bot = await this.bots.resolveByWebhookSecret(secret);
    // An unknown secret gets the same 200 OK as a handled update: telling an attacker
    // which webhook paths exist would let them enumerate tenants.
    if (!bot) {
      logger.warn({ secret: secret.slice(0, 6) }, 'Telegram webhook for unknown bot');
      return { ok: true };
    }

    if (!headerToken || !secureCompare(headerToken, bot.headerSecret)) {
      logger.warn({ tenantId: bot.tenantId }, 'Telegram webhook with bad secret token');
      return { ok: true };
    }

    if (bot.tenant.status === 'SUSPENDED' || bot.tenant.status === 'DELETED') return { ok: true };

    // Telegram retries aggressively, so deduplication comes before any side effect.
    // A unique-constraint violation here *is* the duplicate signal.
    const key = `${bot.botId}:${update.update_id}`;
    try {
      await this.prisma.system('telegram-dedup', () =>
        this.prisma.raw.processedWebhook.create({
          data: { source: 'telegram', key, tenantId: bot.tenantId },
        }),
      );
    } catch {
      return { ok: true };
    }

    await this.prisma.system('telegram-touch', () =>
      this.prisma.raw.telegramBot.update({
        where: { id: bot.id },
        data: { lastUpdateAt: new Date() },
      }),
    );

    // Answer Telegram quickly; the work happens inside the tenant's context.
    try {
      await tenantContext.run({ tenantId: bot.tenantId, actor: { type: 'BOT' } }, () =>
        this.router.route(bot.tenantId, update),
      );
    } catch (error) {
      // Never surface an error to Telegram: it would retry the same update forever.
      logger.error(
        { err: error, tenantId: bot.tenantId, updateId: update.update_id },
        'Telegram update failed',
      );
    }
    return { ok: true };
  }
}

@Controller('shop/auth')
export class MiniAppAuthController {
  constructor(private readonly auth: TelegramAuthService) {}

  /**
   * Exchanges Telegram's signed initData for a customer session.
   * @Public because this is where a session is created; the signature is the credential.
   */
  @Public()
  @Post('telegram')
  @HttpCode(200)
  authenticate(
    @Body(zodBody(telegramAuthSchema))
    dto: {
      initData: string;
      tenantSlug?: string;
      tenantId?: string;
    },
  ) {
    return this.auth.authenticate(dto);
  }
}

@Controller('t/:tenantId/telegram')
@RequireModule('TELEGRAM')
export class TelegramAdminController {
  constructor(private readonly bots: TelegramBotService) {}

  @Get()
  @RequirePermission('integration:read', 'settings:read')
  status() {
    return this.bots.status();
  }

  @Post('connect')
  @RequirePermission('integration:write')
  connect(
    @CurrentActor() actor: RequestActor,
    @Body(zodBody(connectTelegramBotSchema)) dto: { botToken: string },
  ) {
    return this.bots.connect(actor.userId!, dto.botToken);
  }

  @Delete('connect')
  @RequirePermission('integration:write')
  disconnect(@CurrentActor() actor: RequestActor) {
    return this.bots.disconnect(actor.userId!);
  }
}
