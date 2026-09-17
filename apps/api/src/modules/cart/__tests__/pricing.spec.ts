import { describe, it, expect } from 'vitest';
import { PricingService, type PricingInput, type PricingLineInput } from '../pricing.service';
import { DomainError, ErrorCode } from '@bizbot/shared';

/**
 * Invariant I2 — the server prices every order.
 *
 * These are the rules a customer disputes and an accountant audits, so they are tested
 * exhaustively and without a database.
 */
const pricing = new PricingService();

const line = (over: Partial<PricingLineInput> = {}): PricingLineInput => ({
  productId: 'p1',
  quantity: 1,
  unitPrice: 35000,
  variantPriceModifier: 0,
  modifiers: [],
  nameSnapshot: { uz: 'Osh' },
  ...over,
});

const base = (over: Partial<PricingInput> = {}): PricingInput => ({
  lines: [line()],
  fulfillmentType: 'PICKUP',
  delivery: { enabled: true, flatFee: 15000, freeAbove: 200000, minOrderTotal: 0 },
  loyalty: { enabled: true, rate: 5, minOrderTotal: 0, maxRedeemPercent: 50 },
  requestedLoyaltySpend: 0,
  availableLoyaltyBalance: 0,
  ...over,
});

describe('line pricing', () => {
  it('multiplies quantity and adds modifiers per unit', () => {
    const result = pricing.compute(base({
      lines: [line({
        quantity: 3,
        unitPrice: 45000,
        modifiers: [
          { optionId: 'm1', name: { uz: 'Pishloq' }, price: 8000 },
          { optionId: 'm2', name: { uz: 'Go‘sht' }, price: 15000 },
        ],
      })],
    }));
    // (45000 + 23000) * 3
    expect(result.subtotal).toBe(204000);
    expect(result.lines[0]!.modifiersPrice).toBe(23000);
  });

  it('applies a variant delta on top of the base price, not instead of it', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 25000, variantPriceModifier: 15000, quantity: 2 })],
    }));
    expect(result.lines[0]!.effectiveUnitPrice).toBe(40000);
    expect(result.subtotal).toBe(80000);
  });

  it('refuses a variant delta that makes a price negative rather than clamping it', () => {
    expect(() =>
      pricing.compute(base({ lines: [line({ unitPrice: 10000, variantPriceModifier: -15000 })] })),
    ).toThrow(DomainError);
  });

  it('rejects an empty cart', () => {
    expect(() => pricing.compute(base({ lines: [] }))).toThrow(
      expect.objectContaining({ code: ErrorCode.CART_EMPTY }),
    );
  });
});

describe('promo codes', () => {
  it('applies a percentage discount', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 100000 })],
      promo: { id: 'x', code: 'ANOR10', type: 'PERCENTAGE', value: 10, minOrderTotal: 0, maxDiscount: null },
    }));
    expect(result.promoDiscount).toBe(10000);
    expect(result.total).toBe(90000);
  });

  it('honours the maximum discount cap', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 1_000_000 })],
      promo: { id: 'x', code: 'ANOR10', type: 'PERCENTAGE', value: 10, minOrderTotal: 0, maxDiscount: 30000 },
    }));
    expect(result.promoDiscount).toBe(30000);
  });

  it('refuses a code below its minimum order total', () => {
    expect(() =>
      pricing.compute(base({
        lines: [line({ unitPrice: 50000 })],
        promo: { id: 'x', code: 'ANOR10', type: 'PERCENTAGE', value: 10, minOrderTotal: 100000, maxDiscount: null },
      })),
    ).toThrow(expect.objectContaining({ code: ErrorCode.PROMO_NOT_APPLICABLE }));
  });

  it('never discounts more than the order is worth', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 20000 })],
      promo: { id: 'x', code: 'BIG', type: 'FIXED', value: 500000, minOrderTotal: 0, maxDiscount: null },
    }));
    expect(result.promoDiscount).toBe(20000);
    expect(result.total).toBe(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('fails loudly on a promo type that is declared but not implemented', () => {
    // Charging full price while the UI promised a free item is the worse outcome.
    expect(() =>
      pricing.compute(base({
        promo: { id: 'x', code: 'BXGY', type: 'BUY_X_GET_Y', value: 1, minOrderTotal: 0, maxDiscount: null },
      })),
    ).toThrow(DomainError);
  });
});

describe('loyalty redemption', () => {
  it('caps redemption at the configured share of the order', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 100000 })],
      requestedLoyaltySpend: 80000,
      availableLoyaltyBalance: 80000,
      loyalty: { enabled: true, rate: 5, minOrderTotal: 0, maxRedeemPercent: 50 },
    }));
    expect(result.loyaltyDiscount).toBe(50000);
  });

  it('refuses to spend more bonus than the customer has', () => {
    expect(() =>
      pricing.compute(base({ requestedLoyaltySpend: 10000, availableLoyaltyBalance: 5000 })),
    ).toThrow(expect.objectContaining({ code: ErrorCode.INSUFFICIENT_LOYALTY_BALANCE }));
  });

  it('applies loyalty after the promo, so the two cannot exceed the order', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 100000 })],
      promo: { id: 'x', code: 'HALF', type: 'PERCENTAGE', value: 50, minOrderTotal: 0, maxDiscount: null },
      requestedLoyaltySpend: 100000,
      availableLoyaltyBalance: 100000,
      loyalty: { enabled: true, rate: 5, minOrderTotal: 0, maxRedeemPercent: 100 },
    }));
    expect(result.promoDiscount).toBe(50000);
    expect(result.loyaltyDiscount).toBe(50000); // capped at what remains, not the full 100000
    expect(result.total).toBe(0);
  });

  it('earns cashback on what was actually paid, not on the pre-discount subtotal', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 100000 })],
      promo: { id: 'x', code: 'TEN', type: 'PERCENTAGE', value: 10, minOrderTotal: 0, maxDiscount: null },
    }));
    expect(result.total).toBe(90000);
    expect(result.loyaltyEarn).toBe(4500); // 5% of 90000, not of 100000
  });
});

describe('delivery', () => {
  it('charges the flat fee below the free-delivery threshold', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 100000 })],
      fulfillmentType: 'DELIVERY',
    }));
    expect(result.deliveryFee).toBe(15000);
    expect(result.total).toBe(115000);
  });

  it('waives the fee above the threshold', () => {
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 250000 })],
      fulfillmentType: 'DELIVERY',
    }));
    expect(result.deliveryFee).toBe(0);
  });

  it('judges the threshold after discount, so a promo cannot silently add a fee', () => {
    // 210000 qualifies; a 10% promo drops it to 189000, below the 200000 threshold.
    const result = pricing.compute(base({
      lines: [line({ unitPrice: 210000 })],
      fulfillmentType: 'DELIVERY',
      promo: { id: 'x', code: 'TEN', type: 'PERCENTAGE', value: 10, minOrderTotal: 0, maxDiscount: null },
    }));
    expect(result.deliveryFee).toBe(15000);
  });

  it('charges nothing for pickup even when delivery is configured', () => {
    expect(pricing.compute(base({ fulfillmentType: 'PICKUP' })).deliveryFee).toBe(0);
  });

  it('enforces a minimum order total for delivery', () => {
    expect(() =>
      pricing.compute(base({
        lines: [line({ unitPrice: 20000 })],
        fulfillmentType: 'DELIVERY',
        delivery: { enabled: true, flatFee: 15000, freeAbove: null, minOrderTotal: 50000 },
      })),
    ).toThrow(expect.objectContaining({ code: ErrorCode.MINIMUM_ORDER_NOT_MET }));
  });
});

describe('totals always reconcile', () => {
  it('spreads an order-level discount so the lines still sum to the order', () => {
    const result = pricing.compute(base({
      lines: [
        line({ productId: 'a', unitPrice: 35000 }),
        line({ productId: 'b', unitPrice: 45000 }),
        line({ productId: 'c', unitPrice: 69000 }),
      ],
      promo: { id: 'x', code: 'TEN', type: 'PERCENTAGE', value: 10, minOrderTotal: 0, maxDiscount: null },
    }));

    const lineSum = result.lines.reduce((sum, l) => sum + l.total, 0);
    expect(lineSum).toBe(result.subtotal - result.discountTotal);
    // Not a single so'm invented or lost in the rounding.
    expect(result.lines.reduce((s, l) => s + l.discount, 0)).toBe(result.discountTotal);
  });

  it('satisfies the database CHECK constraint on every generated total', () => {
    // total = subtotal - discountTotal + deliveryFee + taxTotal is enforced in SQL, so a
    // result that violates it would fail at insert time rather than here.
    for (const unitPrice of [1, 999, 35000, 199999, 1_000_003]) {
      for (const percent of [0, 7, 10, 33, 100]) {
        const result = pricing.compute(base({
          lines: [line({ unitPrice, quantity: 3 }), line({ productId: 'b', unitPrice: unitPrice + 1 })],
          fulfillmentType: 'DELIVERY',
          promo: percent > 0
            ? { id: 'x', code: 'P', type: 'PERCENTAGE', value: percent, minOrderTotal: 0, maxDiscount: null }
            : null,
        }));

        expect(result.total).toBe(
          result.subtotal - result.discountTotal + result.deliveryFee + result.taxTotal,
        );
        expect(result.total).toBeGreaterThanOrEqual(0);
        expect(result.lines.reduce((s, l) => s + l.total, 0)).toBe(
          result.subtotal - result.discountTotal,
        );
      }
    }
  });
});
