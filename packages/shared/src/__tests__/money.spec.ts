import { describe, it, expect } from 'vitest';
import {
  formatMoney, parseMoney, applyPercentage, distributeProportionally, sumBig, formatAmount,
} from '../money';

describe('formatMoney', () => {
  it('formats UZS with grouped thousands and a suffix symbol', () => {
    expect(formatMoney(150000)).toBe('150 000 so‘m'.replace('‘', "'"));
  });

  it('uses the Russian word for so’m when the locale is Russian', () => {
    expect(formatMoney(35000, 'UZS', 'ru')).toBe('35 000 сум');
  });

  it('respects the currency exponent', () => {
    expect(formatMoney(1999, 'USD')).toBe('$19.99');
    expect(formatMoney(100, 'USD')).toBe('$1.00');
  });

  it('handles zero and negative amounts', () => {
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(-5000)).toBe('−5 000');
  });

  it('handles amounts beyond Int32 via BigInt', () => {
    expect(formatAmount(9_500_000_000n)).toBe('9 500 000 000');
  });
});

describe('parseMoney', () => {
  it('accepts the formats a person actually types', () => {
    expect(parseMoney('150000')).toBe(150000);
    expect(parseMoney('150 000')).toBe(150000);
    expect(parseMoney('150 000')).toBe(150000);
    expect(parseMoney('150,000')).toBe(150000); // comma read as decimal, UZS exponent 0
  });

  it('respects the exponent for decimal currencies', () => {
    expect(parseMoney('19.99', 'USD')).toBe(1999);
    expect(parseMoney('19.9', 'USD')).toBe(1990);
    expect(parseMoney('19', 'USD')).toBe(1900);
  });

  it('returns null rather than silently coercing invalid input', () => {
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('12.3.4')).toBeNull();
  });
});

describe('applyPercentage', () => {
  it('rounds to whole minor units', () => {
    expect(applyPercentage(35000, 15)).toBe(5250);
    expect(applyPercentage(33333, 10)).toBe(3333);
    expect(applyPercentage(1, 50)).toBe(1); // 0.5 rounds half up
  });
});

describe('distributeProportionally', () => {
  it('always sums back to the total', () => {
    const parts = distributeProportionally(10000, [35000, 45000, 69000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('gives the remainder to the largest fractional parts, deterministically', () => {
    // 100 across three equal lines: 34/33/33, not 33/33/33 losing 1.
    const parts = distributeProportionally(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('handles a zero total and zero weights without dividing by zero', () => {
    expect(distributeProportionally(0, [1, 2])).toEqual([0, 0]);
    expect(distributeProportionally(500, [0, 0])).toEqual([0, 0]);
  });

  it('never invents money on a pathological split', () => {
    const weights = [1, 1, 1, 1, 1, 1, 1];
    const parts = distributeProportionally(1, weights);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('sumBig', () => {
  it('accumulates past Int32 without overflow', () => {
    expect(sumBig([2_000_000_000, 2_000_000_000])).toBe(4_000_000_000n);
  });
});
