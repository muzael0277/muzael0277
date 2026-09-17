import { Injectable } from '@nestjs/common';
import { TelegramClient, TelegramApiError } from '@bizbot/telegram';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { loadEnv } from '@bizbot/config';
import { maskSecret } from '@bizbot/database';
import { randomSecret } from '@bizbot/shared/server';
import { PrismaService } from '../../infra/prisma.service';
import { VaultService } from '../../infra/vault.service';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../common/logger';

/**
 * Bot connection.
 *
 * Each tenant brings its own bot, so customers are talking to the business rather than to
 * a platform (docs/architecture/07-telegram.md). The token is tenant data: encrypted at
 * rest, never returned to a client, and masked everywhere it is displayed.
 */
@Injectable()
export class TelegramBotService {
  private readonly env = loadEnv();
  private readonly clients = new Map<string, TelegramClient>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
    private readonly audit: AuditService,
  ) {}

  /** Connects a BotFather token: validates it, stores it encrypted, registers the webhook. */
  async connect(actorUserId: string, botToken: string) {
    const probe = new TelegramClient(botToken, { apiBase: this.env.TELEGRAM_API_BASE });

    let info;
    try {
      info = await probe.getMe();
    } catch (error) {
      // A bad token must fail here, with a clear message, rather than silently producing
      // a bot that never responds.
      throw new DomainError(ErrorCode.TELEGRAM_BOT_TOKEN_INVALID, undefined, {
        reason: error instanceof TelegramApiError ? error.description : 'Unreachable',
      });
    }

    // One bot cannot serve two businesses: updates would be ambiguous.
    const existing = await this.prisma.system('telegram-bot-uniqueness', () =>
      this.prisma.raw.telegramBot.findUnique({ where: { botId: BigInt(info.id) } }),
    );
    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    if (existing && existing.tenantId !== tenant.id) {
      throw new DomainError(ErrorCode.TELEGRAM_BOT_ALREADY_CONNECTED);
    }

    const sealed = this.vault.seal(botToken);
    const webhookSecret = randomSecret(24);
    const headerSecret = randomSecret(16);

    const bot = await this.prisma.client.telegramBot.upsert({
      where: { tenantId: tenant.id },
      create: {
        tenantId: tenant.id,
        botTokenCipher: sealed.cipher,
        botTokenIv: sealed.iv,
        botTokenTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        tokenHint: botToken.slice(-4),
        botId: BigInt(info.id),
        botUsername: info.username,
        botName: info.first_name,
        webhookSecret,
        headerSecret,
        status: 'PENDING',
      },
      update: {
        botTokenCipher: sealed.cipher,
        botTokenIv: sealed.iv,
        botTokenTag: sealed.tag,
        keyVersion: sealed.keyVersion,
        tokenHint: botToken.slice(-4),
        botId: BigInt(info.id),
        botUsername: info.username,
        botName: info.first_name,
        webhookSecret,
        headerSecret,
        status: 'PENDING',
        lastError: null,
      },
    });

    this.clients.delete(tenant.id);

    // Changing a bot token is a security-relevant action; the token itself never enters
    // the audit record.
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'telegram.bot_connected',
      entityType: 'TELEGRAM_BOT',
      entityId: bot.id,
      after: { botUsername: info.username, tokenHint: bot.tokenHint },
    });

    const webhook = await this.registerWebhook(
      tenant.id,
      tenant.slug,
      botToken,
      bot.webhookSecret,
      bot.headerSecret,
    );
    await this.configureCommands(botToken, tenant.slug);

    return this.status();
  }

  async disconnect(actorUserId: string) {
    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    const bot = await this.prisma.client.telegramBot.findFirst({ where: { tenantId: tenant.id } });
    if (!bot) return { connected: false };

    try {
      const client = await this.clientFor(tenant.id);
      await client?.deleteWebhook();
    } catch (error) {
      // Telegram being unreachable must not block a tenant from disconnecting.
      logger.warn({ err: error, tenantId: tenant.id }, 'Could not remove Telegram webhook');
    }

    await this.prisma.client.telegramBot.delete({ where: { id: bot.id } });
    this.clients.delete(tenant.id);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'telegram.bot_disconnected',
      entityType: 'TELEGRAM_BOT',
      entityId: bot.id,
    });
    return { connected: false };
  }

  /** What the admin UI shows. The token appears only masked. */
  async status() {
    const bot = await this.prisma.client.telegramBot.findFirst();
    if (!bot) return { connected: false as const };

    return {
      connected: true as const,
      botUsername: bot.botUsername,
      botName: bot.botName,
      status: bot.status,
      lastError: bot.lastError,
      lastUpdateAt: bot.lastUpdateAt,
      webhookSetAt: bot.webhookSetAt,
      tokenMasked: maskSecret(`${bot.botId}:${'*'.repeat(30)}${bot.tokenHint}`),
      miniAppUrl: `${this.env.MINIAPP_URL}/${(await this.prisma.client.tenant.findFirstOrThrow()).slug}`,
      mode: this.env.TELEGRAM_MODE,
    };
  }

  /** Decrypts a bot token for outbound use. Cached per tenant to avoid repeated decryption. */
  async clientFor(tenantId: string): Promise<TelegramClient | null> {
    const cached = this.clients.get(tenantId);
    if (cached) return cached;

    const bot = await this.prisma.system('telegram-client', () =>
      this.prisma.raw.telegramBot.findUnique({ where: { tenantId } }),
    );
    if (!bot) return null;

    const token = this.vault.open({
      cipher: bot.botTokenCipher,
      iv: bot.botTokenIv,
      tag: bot.botTokenTag,
      keyVersion: bot.keyVersion,
    });
    const client = new TelegramClient(token, { apiBase: this.env.TELEGRAM_API_BASE });
    this.clients.set(tenantId, client);
    return client;
  }

  /** Resolves bot → tenant for the webhook gateway, before any tenant is in context. */
  async resolveByWebhookSecret(secret: string) {
    return this.prisma.system('telegram-webhook-resolve', () =>
      this.prisma.raw.telegramBot.findUnique({
        where: { webhookSecret: secret },
        include: {
          tenant: {
            select: { id: true, slug: true, name: true, status: true, defaultLanguage: true },
          },
        },
      }),
    );
  }

  async markBotBlocked(tenantId: string, customerId: string) {
    await this.prisma.system('telegram-blocked', () =>
      this.prisma.raw.customer.update({ where: { id: customerId }, data: { botBlocked: true } }),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async registerWebhook(
    tenantId: string,
    tenantSlug: string,
    botToken: string,
    webhookSecret: string,
    headerSecret: string,
  ) {
    if (this.env.TELEGRAM_MODE !== 'webhook') {
      // Local development runs long polling so no public tunnel is needed. The bot is
      // still fully connected; only the delivery mechanism differs.
      await this.prisma.client.telegramBot.updateMany({
        where: { tenantId },
        data: { status: 'ACTIVE' },
      });
      return { mode: this.env.TELEGRAM_MODE };
    }

    const url = `${this.env.TELEGRAM_WEBHOOK_BASE_URL}/v1/telegram/webhook/${webhookSecret}`;
    try {
      const client = new TelegramClient(botToken, { apiBase: this.env.TELEGRAM_API_BASE });
      await client.setWebhook(url, headerSecret);
      await this.prisma.client.telegramBot.updateMany({
        where: { tenantId },
        data: { status: 'ACTIVE', webhookSetAt: new Date(), lastError: null },
      });
      return { mode: 'webhook', url };
    } catch (error) {
      const description = error instanceof TelegramApiError ? error.description : String(error);
      // The token is valid but the webhook could not be set — usually an unreachable
      // public URL. Say so, rather than reporting a generic failure.
      await this.prisma.client.telegramBot.updateMany({
        where: { tenantId },
        data: { status: 'ERROR', lastError: description },
      });
      throw new DomainError(
        ErrorCode.INTERNAL,
        'The bot token is valid, but Telegram could not reach the webhook URL. Is the public address correct and served over HTTPS?',
        { url, description },
      );
    }
  }

  private async configureCommands(botToken: string, tenantSlug: string) {
    const client = new TelegramClient(botToken, { apiBase: this.env.TELEGRAM_API_BASE });
    try {
      await client.setMyCommands([
        { command: 'start', description: 'Boshlash / Начать' },
        { command: 'menu', description: 'Menyu / Меню' },
        { command: 'orders', description: 'Buyurtmalarim / Мои заказы' },
        { command: 'bookings', description: 'Bronlarim / Мои записи' },
        { command: 'help', description: 'Yordam / Помощь' },
      ]);
      await client.setChatMenuButton(`${this.env.MINIAPP_URL}/${tenantSlug}`, 'Ilova / Приложение');
    } catch (error) {
      // Cosmetic setup; a failure here must not fail the connection.
      logger.warn({ err: error }, 'Could not configure bot commands');
    }
  }
}
