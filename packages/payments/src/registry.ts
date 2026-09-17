import type { PaymentProvider, PaymentProviderKey } from './provider';
import { CashProvider } from './providers/cash';
import { ClickProvider } from './providers/click';
import { PaymeProvider } from './providers/payme';
import { MockProvider } from './providers/mock';

/**
 * Provider lookup. Adding a payment method is a file here plus an Integration row —
 * no change to order, cart or checkout code.
 */
const PROVIDERS: Record<PaymentProviderKey, PaymentProvider> = {
  cash: new CashProvider(),
  click: new ClickProvider(),
  payme: new PaymeProvider(),
  mock: new MockProvider(),
  // Telegram Stars is declared in the domain but has no adapter yet; asking for it
  // fails loudly rather than silently falling back to another provider.
  telegram_stars: undefined as unknown as PaymentProvider,
};

export function getProvider(key: PaymentProviderKey): PaymentProvider {
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`Payment provider "${key}" is not available`);
  return provider;
}

export function availableProviders(): PaymentProviderKey[] {
  return (Object.keys(PROVIDERS) as PaymentProviderKey[]).filter((k) => PROVIDERS[k] !== undefined);
}

/** Maps the PaymentMethod stored on an order to its provider. */
export function providerForMethod(method: string): PaymentProviderKey {
  switch (method) {
    case 'CASH':
    case 'CARD_TERMINAL':
      return 'cash';
    case 'CLICK':
      return 'click';
    case 'PAYME':
      return 'payme';
    case 'TELEGRAM_STARS':
      return 'telegram_stars';
    default:
      return 'mock';
  }
}
