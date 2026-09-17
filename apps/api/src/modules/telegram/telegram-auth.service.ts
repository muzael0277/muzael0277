import { Injectable } from '@nestjs/common';
import { verifyInitData } from '@bizbot/telegram';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { languageFromTelegram } from '@bizbot/i18n';
import { tenantContext } from '@bizbot/database';
import { PrismaService } from '../../infra/prisma.service';
import { VaultService } from '../../infra/vault.service';
import { TokenService } from '../auth/token.service';
import { CustomersService } from '../crm/customers.service';
import { logger } from '../../common/logger';

/**
 * Mini App authentication.
 *
 * The client hands over Telegram's signed initData. Nothing inside it is trusted until
 * the HMAC checks out — anyone can open a Mini App URL and edit the payload, so skipping
 * verification is a complete authentication bypass (docs/architecture/07-telegram.md).
 */
@Injectable()
export class TelegramAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
    private readonly tokens: TokenService,
    private readonly customers: CustomersService,
  ) {}

  async authenticate(input: { initData: string; tenantSlug?: string; tenantId?: string }) {
    // Resolving which business this is necessarily happens before a tenant is in context.
    const tenant = await this.prisma.system('miniapp-auth-resolve-tenant', () =>
      this.prisma.raw.tenant.findFirst({
        where: input.tenantId ? { id: input.tenantId } : { slug: input.tenantSlug },
        include: { telegramBot: true },
      }),
    );
    if (!tenant) throw new DomainError(ErrorCode.NOT_FOUND, 'Business not found');
    if (tenant.status === 'SUSPENDED' || tenant.status === 'DELETED') {
      throw new DomainError(ErrorCode.TENANT_SUSPENDED);
    }
    if (!tenant.telegramBot) {
      throw new DomainError(ErrorCode.TELEGRAM_BOT_TOKEN_INVALID, 'This business has not connected a bot yet');
    }

    const botToken = this.vault.open({
      cipher: tenant.telegramBot.botTokenCipher,
      iv: tenant.telegramBot.botTokenIv,
      tag: tenant.telegramBot.botTokenTag,
      keyVersion: tenant.telegramBot.keyVersion,
    });

    const result = verifyInitData(input.initData, botToken);
    if (!result.ok) {
      logger.warn({ tenantId: tenant.id, reason: result.reason }, 'Mini App initData rejected');
      throw new DomainError(
        result.reason === 'EXPIRED'
          ? ErrorCode.TELEGRAM_INITDATA_EXPIRED
          : ErrorCode.TELEGRAM_SIGNATURE_INVALID,
      );
    }

    const tgUser = result.data.user;
    if (!tgUser) throw new DomainError(ErrorCode.TELEGRAM_SIGNATURE_INVALID, 'initData contains no user');

    // From here the tenant is established by the signature, not by the request, so the
    // rest runs inside a normal tenant context.
    const customer = await tenantContext.run({ tenantId: tenant.id, actor: { type: 'BOT' } }, () =>
      this.customers.upsertFromTelegram({
        telegramUserId: BigInt(tgUser.id),
        firstName: tgUser.first_name,
        lastName: tgUser.last_name,
        username: tgUser.username,
        languageCode: languageFromTelegram(tgUser.language_code),
      }),
    );

    if (customer.isBlocked) throw new DomainError(ErrorCode.FORBIDDEN, 'Customer is blocked');

    const session = await this.tokens.issueForCustomer({ id: customer.id, tenantId: tenant.id });

    return {
      ...session,
      customer: {
        id: customer.id, firstName: customer.firstName, lastName: customer.lastName,
        phone: customer.phone, language: customer.language,
      },
      tenant: {
        id: tenant.id, slug: tenant.slug, name: tenant.name,
        logoUrl: tenant.logoUrl, primaryColor: tenant.primaryColor,
        currency: tenant.currency, defaultLanguage: tenant.defaultLanguage,
      },
      startParam: result.data.start_param ?? null,
    };
  }
}
