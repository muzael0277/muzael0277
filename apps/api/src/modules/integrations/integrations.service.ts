import { Injectable } from '@nestjs/common';
import { getProvider, availableProviders, type PaymentProviderKey } from '@bizbot/payments';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { loadEnv } from '@bizbot/config';
import { PrismaService } from '../../infra/prisma.service';
import { VaultService } from '../../infra/vault.service';
import { AuditService } from '../audit/audit.service';

/**
 * The integration framework.
 *
 * Generic by design: payments are simply its first consumer, and SMS, delivery or
 * accounting connectors are rows rather than new subsystems
 * (docs/adr/0004-provider-adapters.md).
 *
 * Invariant I7: credentials are encrypted on receipt and never returned. Every response
 * from this service reports *which* keys are configured, never their values.
 */
@Injectable()
export class IntegrationsService {
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
    private readonly audit: AuditService,
  ) {}

  /** The catalogue the admin UI renders, merged with what this tenant has configured. */
  async list() {
    const configured = await this.prisma.client.integration.findMany({ orderBy: { provider: 'asc' } });
    const byKey = new Map(configured.map((i) => [`${i.type}:${i.provider}`, i]));

    const catalogue = availableProviders()
      .filter((key) => key !== 'mock' || this.env.ENABLE_DEMO_MODE)
      .map((key) => {
        const provider = getProvider(key);
        const existing = byKey.get(`PAYMENT:${key}`);
        return {
          type: 'PAYMENT' as const,
          provider: key,
          label: PROVIDER_LABELS[key],
          capabilities: provider.capabilities,
          requiredCredentials: provider.requiredCredentials,
          connected: Boolean(existing),
          isEnabled: existing?.isEnabled ?? false,
          status: existing?.status ?? 'DISCONNECTED',
          lastError: existing?.lastError ?? null,
          // Which credentials are set — never what they are.
          configuredCredentials: existing ? this.credentialKeys(existing) : [],
          config: existing?.config ?? {},
          webhookUrl: existing
            ? `${this.env.API_PUBLIC_URL}/${this.env.API_GLOBAL_PREFIX}/payments/webhook/${key}/${existing.id}`
            : null,
          id: existing?.id ?? null,
        };
      });

    return catalogue;
  }

  async upsert(
    actorUserId: string,
    input: {
      type: string; provider: string;
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
      isEnabled?: boolean;
    },
  ) {
    const tenant = await this.prisma.client.tenant.findFirstOrThrow();

    if (input.type === 'PAYMENT') {
      if (input.provider === 'mock' && !this.env.ENABLE_DEMO_MODE) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'The demo payment provider is disabled');
      }
      const provider = getProvider(input.provider as PaymentProviderKey);

      // Refuse a half-configured integration: a provider missing a credential fails at
      // the worst possible moment, in front of a paying customer.
      const existing = await this.prisma.client.integration.findFirst({
        where: { type: 'PAYMENT', provider: input.provider },
      });
      const alreadySet = existing ? this.credentialKeys(existing) : [];
      const provided = new Set([...alreadySet, ...Object.keys(input.secrets ?? {})]);
      const missing = provider.requiredCredentials.filter((key) => !provided.has(key));
      if (missing.length > 0) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'This provider needs more credentials', {
          provider: input.provider, missing,
        });
      }
    }

    // Merge rather than replace: an admin editing the public config must not silently
    // wipe credentials they did not retype.
    const existing = await this.prisma.client.integration.findFirst({
      where: { type: input.type as never, provider: input.provider },
    });
    const merged = {
      ...(existing ? this.openCredentials(existing) : {}),
      ...(input.secrets ?? {}),
    };
    const sealed = Object.keys(merged).length > 0 ? this.vault.sealJson(merged) : null;

    const integration = await this.prisma.client.integration.upsert({
      where: {
        tenantId_type_provider: {
          tenantId: tenant.id, type: input.type as never, provider: input.provider,
        },
      },
      create: {
        type: input.type as never,
        provider: input.provider,
        config: (input.config ?? {}) as never,
        isEnabled: input.isEnabled ?? true,
        status: sealed ? 'CONNECTED' : 'DISCONNECTED',
        secretCipher: sealed?.cipher, secretIv: sealed?.iv,
        secretTag: sealed?.tag, keyVersion: sealed?.keyVersion ?? 1,
      } as never,
      update: {
        config: (input.config ?? existing?.config ?? {}) as never,
        isEnabled: input.isEnabled ?? existing?.isEnabled ?? true,
        status: sealed ? 'CONNECTED' : 'DISCONNECTED',
        lastError: null,
        ...(sealed
          ? {
              secretCipher: sealed.cipher, secretIv: sealed.iv,
              secretTag: sealed.tag, keyVersion: sealed.keyVersion,
            }
          : {}),
      },
    });

    // Changing payment credentials is exactly the action an investigation asks about.
    await this.audit.record({
      tenantId: tenant.id, actorUserId, action: 'integration.updated',
      entityType: 'INTEGRATION', entityId: integration.id,
      after: {
        provider: input.provider, type: input.type,
        credentialsChanged: Object.keys(input.secrets ?? {}),
      },
    });

    return this.present(integration);
  }

  async remove(actorUserId: string, id: string) {
    const integration = await this.prisma.client.integration.findFirstOrThrow({ where: { id } });
    await this.prisma.client.integration.delete({ where: { id } });
    await this.audit.record({
      tenantId: integration.tenantId, actorUserId, action: 'integration.removed',
      entityType: 'INTEGRATION', entityId: id, before: { provider: integration.provider },
    });
  }

  private present(integration: {
    id: string; type: string; provider: string; status: string; isEnabled: boolean; config: unknown;
    secretCipher: string | null; secretIv: string | null; secretTag: string | null; keyVersion: number;
  }) {
    return {
      id: integration.id,
      type: integration.type,
      provider: integration.provider,
      status: integration.status,
      isEnabled: integration.isEnabled,
      config: integration.config,
      configuredCredentials: this.credentialKeys(integration),
      webhookUrl: `${this.env.API_PUBLIC_URL}/${this.env.API_GLOBAL_PREFIX}/payments/webhook/${integration.provider}/${integration.id}`,
    };
  }

  private credentialKeys(integration: {
    secretCipher: string | null; secretIv: string | null; secretTag: string | null; keyVersion: number;
  }): string[] {
    try {
      return Object.keys(this.openCredentials(integration));
    } catch {
      return [];
    }
  }

  private openCredentials(integration: {
    secretCipher: string | null; secretIv: string | null; secretTag: string | null; keyVersion: number;
  }): Record<string, string> {
    if (!integration.secretCipher || !integration.secretIv || !integration.secretTag) return {};
    return this.vault.openJson({
      cipher: integration.secretCipher, iv: integration.secretIv,
      tag: integration.secretTag, keyVersion: integration.keyVersion,
    });
  }
}

const PROVIDER_LABELS: Record<string, { uz: string; ru: string }> = {
  cash: { uz: 'Naqd pul', ru: 'Наличные' },
  click: { uz: 'Click', ru: 'Click' },
  payme: { uz: 'Payme', ru: 'Payme' },
  telegram_stars: { uz: 'Telegram Stars', ru: 'Telegram Stars' },
  mock: { uz: 'Demo to‘lov', ru: 'Демо-оплата' },
};
