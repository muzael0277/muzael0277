import { Injectable } from '@nestjs/common';
import type { TgUpdate } from '@bizbot/telegram';
import { languageFromTelegram, t } from '@bizbot/i18n';
import { formatMoney, resolveI18n, type Language } from '@bizbot/shared';
import { loadEnv } from '@bizbot/config';
import { PrismaService } from '../../infra/prisma.service';
import { CustomersService } from '../crm/customers.service';
import { TelegramBotService } from './telegram-bot.service';
import { logger } from '../../common/logger';

/**
 * Routes a Telegram update to a handler.
 *
 * Runs inside the resolved tenant's context, so every query is already scoped. The bot
 * menu is built from the tenant's *enabled modules*, which is what keeps a barbershop
 * from showing a "Cart" button and a shop from offering appointments.
 */
@Injectable()
export class TelegramUpdateRouter {
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly bots: TelegramBotService,
  ) {}

  async route(tenantId: string, update: TgUpdate): Promise<void> {
    if (update.message) return this.onMessage(tenantId, update.message);
    if (update.callback_query) return this.onCallback(tenantId, update.callback_query);
    if (update.my_chat_member) {
      // Telegram reports a customer blocking the bot here. Recording it stops the
      // notification engine from burning rate limit on a chat that will never deliver.
      const status = update.my_chat_member.new_chat_member.status;
      if (status === 'kicked' || status === 'left') {
        const customer = await this.prisma.client.customer.findFirst({
          where: { telegramUserId: BigInt(update.my_chat_member.from.id) },
        });
        if (customer) await this.bots.markBotBlocked(tenantId, customer.id);
      }
    }
  }

  private async onMessage(tenantId: string, message: NonNullable<TgUpdate['message']>) {
    const from = message.from;
    if (!from || from.is_bot) return;

    const customer = await this.customers.upsertFromTelegram({
      telegramUserId: BigInt(from.id),
      firstName: from.first_name,
      lastName: from.last_name,
      username: from.username,
      languageCode: languageFromTelegram(from.language_code),
    });

    const lang = (customer.language as Language) ?? 'uz';
    const client = await this.bots.clientFor(tenantId);
    if (!client) return;

    // A shared contact is the fastest way to capture a phone number, and it is the one
    // piece of data that turns a Telegram user into a reachable customer.
    if (message.contact?.phone_number) {
      const digits = message.contact.phone_number.replace(/\D/g, '');
      await this.prisma.client.customer.update({
        where: { id: customer.id },
        data: { phone: digits },
      });
      await client.sendMessage(message.chat.id, '✅ Rahmat! Telefon raqamingiz saqlandi.');
      return;
    }

    const text = (message.text ?? '').trim();

    if (text.startsWith('/start'))
      return this.sendWelcome(tenantId, client, message.chat.id, customer, lang);
    if (text === '/menu') return this.sendMenu(tenantId, client, message.chat.id, lang);
    if (text === '/orders') return this.sendOrders(client, message.chat.id, customer.id, lang);
    if (text === '/bookings') return this.sendBookings(client, message.chat.id, customer.id, lang);

    // Anything else becomes a support conversation rather than an unhelpful error —
    // a customer typing a question should reach a human.
    await this.openConversation(tenantId, customer.id, message.message_id, text);
    await client.sendMessage(message.chat.id, t(lang, 'bot.operatorConnected'));
  }

  private async onCallback(tenantId: string, query: NonNullable<TgUpdate['callback_query']>) {
    const client = await this.bots.clientFor(tenantId);
    if (!client) return;
    await client.answerCallbackQuery(query.id);

    const customer = await this.prisma.client.customer.findFirst({
      where: { telegramUserId: BigInt(query.from.id) },
    });
    if (!customer || !query.message) return;

    const lang = (customer.language as Language) ?? 'uz';
    switch (query.data) {
      case 'orders':
        return this.sendOrders(client, query.message.chat.id, customer.id, lang);
      case 'bookings':
        return this.sendBookings(client, query.message.chat.id, customer.id, lang);
      case 'bonus':
        return this.sendBonus(client, query.message.chat.id, customer.id, lang);
      case 'branches':
        return this.sendBranches(client, query.message.chat.id, lang);
      default:
        return this.sendMenu(tenantId, client, query.message.chat.id, lang);
    }
  }

  // ── replies ──────────────────────────────────────────────────────────────────

  private async sendWelcome(
    tenantId: string,
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    customer: { id: string; phone: string | null },
    lang: Language,
  ) {
    const tenant = await this.prisma.client.tenant.findFirstOrThrow({
      include: { settings: true },
    });
    const description = resolveI18n(tenant.settings?.description as never, lang);

    const text = [
      t(lang, 'bot.welcome', { businessName: tenant.name }),
      description,
      '',
      t(lang, 'bot.menuPrompt'),
    ]
      .filter(Boolean)
      .join('\n');

    await client.sendMessage(chatId, text, {
      reply_markup: await this.menuKeyboard(tenantId, tenant.slug, lang),
    });

    // Ask for a phone number once, and only if we do not have one.
    if (!customer.phone) {
      await client.sendMessage(
        chatId,
        '📱 Buyurtma va bronlar uchun telefon raqamingizni yuboring:',
        {
          reply_markup: {
            keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
    }
  }

  private async sendMenu(
    tenantId: string,
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    lang: Language,
  ) {
    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    await client.sendMessage(chatId, t(lang, 'bot.menuPrompt'), {
      reply_markup: await this.menuKeyboard(tenantId, tenant.slug, lang),
    });
  }

  /** Built from enabled modules, so the bot never offers a button that leads nowhere. */
  private async menuKeyboard(tenantId: string, tenantSlug: string, lang: Language) {
    const modules = new Set(
      (
        await this.prisma.client.tenantModule.findMany({
          where: { enabled: true },
          select: { module: true },
        })
      ).map((m) => m.module),
    );

    const rows: { text: string; callback_data?: string; web_app?: { url: string } }[][] = [];
    const appUrl = `${this.env.MINIAPP_URL}/${tenantSlug}`;

    rows.push([{ text: t(lang, 'bot.openApp'), web_app: { url: appUrl } }]);

    const first: { text: string; callback_data: string }[] = [];
    if (modules.has('CATALOG'))
      first.push({ text: t(lang, 'bot.catalog'), callback_data: 'catalog' });
    if (modules.has('BOOKING')) first.push({ text: t(lang, 'bot.book'), callback_data: 'book' });
    if (first.length) rows.push(first);

    const second: { text: string; callback_data: string }[] = [];
    if (modules.has('ORDERS'))
      second.push({ text: t(lang, 'bot.myOrders'), callback_data: 'orders' });
    if (modules.has('BOOKING'))
      second.push({ text: t(lang, 'bot.myBookings'), callback_data: 'bookings' });
    if (second.length) rows.push(second);

    const third: { text: string; callback_data: string }[] = [];
    if (modules.has('LOYALTY')) third.push({ text: t(lang, 'bot.bonus'), callback_data: 'bonus' });
    if (modules.has('BRANCHES'))
      third.push({ text: t(lang, 'bot.branches'), callback_data: 'branches' });
    if (third.length) rows.push(third);

    rows.push([{ text: t(lang, 'bot.operator'), callback_data: 'operator' }]);
    return { inline_keyboard: rows };
  }

  private async sendOrders(
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    customerId: string,
    lang: Language,
  ) {
    const orders = await this.prisma.client.order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (orders.length === 0) {
      await client.sendMessage(chatId, t(lang, 'empty.orders'));
      return;
    }
    const lines = orders.map(
      (o) =>
        `<b>${o.orderNumber}</b> — ${t(lang, `order.statuses.${o.status}`)}\n${formatMoney(o.total, o.currency as never, lang)}`,
    );
    await client.sendMessage(chatId, lines.join('\n\n'));
  }

  private async sendBookings(
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    customerId: string,
    lang: Language,
  ) {
    const bookings = await this.prisma.client.booking.findMany({
      where: {
        customerId,
        startsAt: { gte: new Date() },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
      orderBy: { startsAt: 'asc' },
      take: 5,
      include: { resource: { select: { name: true } } },
    });
    if (bookings.length === 0) {
      await client.sendMessage(chatId, t(lang, 'empty.bookings'));
      return;
    }
    const lines = bookings.map((b) => {
      const when = b.startsAt.toISOString().replace('T', ' ').slice(0, 16);
      return `<b>${resolveI18n(b.serviceNameSnapshot as never, lang)}</b>\n${when} — ${b.resource.name}\n${t(lang, `booking.statuses.${b.status}`)}`;
    });
    await client.sendMessage(chatId, lines.join('\n\n'));
  }

  private async sendBonus(
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    customerId: string,
    lang: Language,
  ) {
    const account = await this.prisma.client.loyaltyAccount.findFirst({ where: { customerId } });
    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    await client.sendMessage(
      chatId,
      `⭐ ${formatMoney(account?.balance ?? 0, tenant.currency as never, lang)}`,
    );
  }

  private async sendBranches(
    client: NonNullable<Awaited<ReturnType<TelegramBotService['clientFor']>>>,
    chatId: number,
    lang: Language,
  ) {
    const branches = await this.prisma.client.branch.findMany({ where: { isActive: true } });
    if (branches.length === 0) {
      await client.sendMessage(chatId, t(lang, 'empty.search'));
      return;
    }
    const lines = branches.map(
      (b) => `📍 <b>${b.name}</b>\n${b.address ?? ''}${b.phone ? `\n☎️ ${b.phone}` : ''}`,
    );
    await client.sendMessage(chatId, lines.join('\n\n'));
  }

  private async openConversation(
    tenantId: string,
    customerId: string,
    externalId: number,
    body: string,
  ) {
    const conversation = await this.prisma.client.conversation.upsert({
      where: { tenantId_customerId: { tenantId, customerId } },
      create: {
        customerId,
        status: 'OPEN',
        lastMessageAt: new Date(),
        lastMessagePreview: body.slice(0, 120),
        unreadCount: 1,
      } as never,
      update: {
        status: 'OPEN',
        lastMessageAt: new Date(),
        lastMessagePreview: body.slice(0, 120),
        unreadCount: { increment: 1 },
      },
    });

    await this.prisma.client.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'INBOUND',
        body,
        externalId: String(externalId),
      } as never,
    });
  }
}
