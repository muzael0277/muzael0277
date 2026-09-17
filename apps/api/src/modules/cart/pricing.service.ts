import { DomainError, ErrorCode, applyPercentage, distributeProportionally } from '@bizbot/shared';

/**
 * Pricing.
 *
 * Invariant I2: the client never sets a price. It sends *selections* — which product,
 * which variant, which modifiers, how many — and this computes what they cost from the
 * catalog. A total that arrives in a request body is ignored entirely.
 *
 * Deliberately pure: no Prisma, no injection, no I/O. Everything it needs is passed in.
 * That is what makes the money rules exhaustively testable without a database, and money
 * rules that are hard to test do not stay correct.
 */

export interface PricedModifier {
  optionId: string;
  name: unknown;
  price: number;
}

export interface PricingLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /** Base price from the catalog, in minor units. */
  unitPrice: number;
  /** Signed delta for the chosen variant. */
  variantPriceModifier: number;
  modifiers: PricedModifier[];
  nameSnapshot: unknown;
  variantNameSnapshot?: unknown;
  skuSnapshot?: string | null;
  comment?: string;
}

export interface PricedLine extends PricingLineInput {
  /** Catalog price plus the variant delta. Modifiers are tracked separately. */
  effectiveUnitPrice: number;
  modifiersPrice: number;
  lineSubtotal: number;
  /** This line's share of any order-level discount. */
  discount: number;
  total: number;
}

export interface PromoRule {
  id: string;
  code: string;
  type: 'PERCENTAGE' | 'FIXED' | 'BUY_X_GET_Y' | 'FREE_DELIVERY';
  value: number;
  minOrderTotal: number;
  maxDiscount: number | null;
}

export interface DeliveryRule {
  enabled: boolean;
  flatFee: number;
  freeAbove: number | null;
  minOrderTotal: number;
}

export interface LoyaltyRule {
  enabled: boolean;
  /** Percentage of the paid total credited back. */
  rate: number;
  minOrderTotal: number;
  /** Cap on how much of an order bonuses may cover. */
  maxRedeemPercent: number;
}

export interface PricingInput {
  lines: PricingLineInput[];
  fulfillmentType: 'DELIVERY' | 'PICKUP' | 'DINE_IN';
  promo?: PromoRule | null;
  delivery: DeliveryRule;
  loyalty: LoyaltyRule;
  /** Bonus the customer asked to spend; capped here, never trusted as-is. */
  requestedLoyaltySpend: number;
  availableLoyaltyBalance: number;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: number;
  promoDiscount: number;
  loyaltyDiscount: number;
  discountTotal: number;
  deliveryFee: number;
  taxTotal: number;
  total: number;
  /** Credited on completion, not at checkout — an unpaid order earns nothing. */
  loyaltyEarn: number;
}

export class PricingService {
  compute(input: PricingInput): PricingResult {
    if (input.lines.length === 0) throw new DomainError(ErrorCode.CART_EMPTY);

    const lines = input.lines.map((line) => this.priceLine(line));
    const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotal, 0);

    const promoDiscount = this.promoDiscount(input.promo, subtotal, input.fulfillmentType);

    // Loyalty applies after the promo, against what is actually left to pay, so the two
    // cannot together discount more than the order is worth.
    const afterPromo = subtotal - promoDiscount;
    const loyaltyDiscount = this.loyaltyDiscount(input, afterPromo);

    const discountTotal = promoDiscount + loyaltyDiscount;
    const deliveryFee = this.deliveryFee(input, subtotal, promoDiscount);

    if (input.fulfillmentType === 'DELIVERY' && subtotal < input.delivery.minOrderTotal) {
      throw new DomainError(ErrorCode.MINIMUM_ORDER_NOT_MET, undefined, {
        minOrderTotal: input.delivery.minOrderTotal,
        subtotal,
      });
    }

    // Spread the order-level discount across lines so the sum of lines always equals the
    // order subtotal less the discount. Naive per-line rounding loses or invents so'm,
    // and then a receipt does not add up.
    const shares = distributeProportionally(discountTotal, lines.map((l) => l.lineSubtotal));
    lines.forEach((line, i) => {
      line.discount = shares[i] ?? 0;
      line.total = line.lineSubtotal - line.discount;
    });

    const taxTotal = 0; // Uzbek SMBs on the simplified regime do not itemize VAT yet.
    const total = subtotal - discountTotal + deliveryFee + taxTotal;

    return {
      lines,
      subtotal,
      promoDiscount,
      loyaltyDiscount,
      discountTotal,
      deliveryFee,
      taxTotal,
      total,
      loyaltyEarn: this.loyaltyEarn(input.loyalty, total, subtotal),
    };
  }

  private priceLine(line: PricingLineInput): PricedLine {
    if (line.quantity < 1) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Quantity must be at least 1');
    }

    const effectiveUnitPrice = line.unitPrice + line.variantPriceModifier;
    if (effectiveUnitPrice < 0) {
      // A variant delta that drives the price below zero is a configuration error, and
      // silently clamping it would hide a pricing mistake until it reached a receipt.
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Variant price modifier produces a negative price', {
        productId: line.productId,
      });
    }

    const modifiersPrice = line.modifiers.reduce((sum, m) => sum + m.price, 0);
    const lineSubtotal = (effectiveUnitPrice + modifiersPrice) * line.quantity;

    return {
      ...line,
      effectiveUnitPrice,
      modifiersPrice,
      lineSubtotal,
      discount: 0,
      total: lineSubtotal,
    };
  }

  private promoDiscount(
    promo: PromoRule | null | undefined,
    subtotal: number,
    fulfillmentType: string,
  ): number {
    if (!promo) return 0;
    if (subtotal < promo.minOrderTotal) {
      throw new DomainError(ErrorCode.PROMO_NOT_APPLICABLE, undefined, {
        code: promo.code, minOrderTotal: promo.minOrderTotal, subtotal,
      });
    }

    let discount: number;
    switch (promo.type) {
      case 'PERCENTAGE':
        discount = applyPercentage(subtotal, promo.value);
        break;
      case 'FIXED':
        discount = promo.value;
        break;
      case 'FREE_DELIVERY':
        // Handled in deliveryFee; it does not reduce the goods subtotal.
        return 0;
      case 'BUY_X_GET_Y':
        // Declared in the schema, not implemented in MVP. Failing loudly beats charging
        // full price while the UI promises a free item.
        throw new DomainError(ErrorCode.PROMO_NOT_APPLICABLE, 'This promotion type is not available yet', {
          code: promo.code, type: promo.type,
        });
      default:
        discount = 0;
    }

    if (promo.maxDiscount !== null) discount = Math.min(discount, promo.maxDiscount);
    // A discount larger than the order would make the total negative.
    return Math.max(0, Math.min(discount, subtotal));
  }

  private loyaltyDiscount(input: PricingInput, afterPromo: number): number {
    if (!input.loyalty.enabled || input.requestedLoyaltySpend <= 0) return 0;

    if (input.requestedLoyaltySpend > input.availableLoyaltyBalance) {
      throw new DomainError(ErrorCode.INSUFFICIENT_LOYALTY_BALANCE, undefined, {
        requested: input.requestedLoyaltySpend,
        available: input.availableLoyaltyBalance,
      });
    }

    // The cap is a business rule: a shop that lets bonuses cover an entire order has
    // effectively given the goods away.
    const cap = applyPercentage(afterPromo, input.loyalty.maxRedeemPercent);
    return Math.max(0, Math.min(input.requestedLoyaltySpend, cap, afterPromo));
  }

  private deliveryFee(input: PricingInput, subtotal: number, promoDiscount: number): number {
    if (input.fulfillmentType !== 'DELIVERY' || !input.delivery.enabled) return 0;
    if (input.promo?.type === 'FREE_DELIVERY' && subtotal >= input.promo.minOrderTotal) return 0;

    // Free-delivery thresholds are judged on the goods total after discount: otherwise a
    // promo code could push an order under the threshold and surprise the customer with
    // a delivery fee that was not there a moment ago.
    const qualifying = subtotal - promoDiscount;
    if (input.delivery.freeAbove !== null && qualifying >= input.delivery.freeAbove) return 0;
    return input.delivery.flatFee;
  }

  private loyaltyEarn(rule: LoyaltyRule, total: number, subtotal: number): number {
    if (!rule.enabled || rule.rate <= 0) return 0;
    if (subtotal < rule.minOrderTotal) return 0;
    // Earned on what the customer actually pays, so bonuses cannot compound on bonuses.
    return applyPercentage(total, rule.rate);
  }
}

export const pricingService = new PricingService();
