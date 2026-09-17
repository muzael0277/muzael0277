import { describe, it, expect } from 'vitest';
import {
  phoneSchema,
  passwordSchema,
  moneySchema,
  slugSchema,
  i18nTextSchema,
  timeRangeSchema,
  paginationSchema,
  timeOfDaySchema,
  dateOnlySchema,
} from '../primitives';
import { registerSchema } from '../auth';
import { addCartItemSchema, checkoutSchema } from '../commerce';
import { createBookingSchema } from '../booking';

/**
 * The contracts are the API's outer wall: every request is parsed here before a service
 * sees it. These tests pin the two things that matter — that bad input is refused, and
 * that good input is normalized to exactly one shape, so services never have to guess
 * whether a phone number arrived as "+998 90 123 45 67" or "998901234567".
 */

const ID = 'aa000000-0000-4000-8000-0000000000aa';

describe('phone', () => {
  it.each(['+998 90 123 45 67', '998901234567', '+998901234567', '90 123 45 67', '(90) 123-45-67'])(
    'normalizes %s to E.164',
    (input) => {
      expect(phoneSchema.parse(input)).toBe('998901234567');
    },
  );

  it.each(['12345', '+7 900 123 45 67', '998 00 123 45 67', ''])('rejects %s', (input) => {
    expect(phoneSchema.safeParse(input).success).toBe(false);
  });
});

describe('password', () => {
  it('accepts a long passphrase with no special characters', () => {
    // Length beats composition rules; a rule demanding punctuation produces "Password1!".
    expect(passwordSchema.safeParse('olmalar bogida').success).toBe(true);
  });

  it('rejects anything under ten characters', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
  });

  it('rejects a single repeated character and known-trivial strings', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaa').success).toBe(false);
    expect(passwordSchema.safeParse('QWERTYUIOP').success).toBe(false);
  });
});

describe('money', () => {
  it('accepts whole minor units', () => {
    expect(moneySchema.parse(69000)).toBe(69000);
  });

  it('rejects fractions and negatives', () => {
    // UZS has exponent 0: a fractional price is always a unit-conversion bug upstream.
    expect(moneySchema.safeParse(69000.5).success).toBe(false);
    expect(moneySchema.safeParse(-1).success).toBe(false);
  });

  it('rejects a value past the sane ceiling', () => {
    expect(moneySchema.safeParse(9_000_000_000).success).toBe(false);
  });
});

describe('slug', () => {
  it.each(['anor-cafe', 'barber-house', 'zebo2'])('accepts %s', (s) => {
    expect(slugSchema.parse(s)).toBe(s);
  });

  it.each(['Anor-Cafe', '-anor', 'anor--cafe', 'anor cafe', 'a'])('rejects %s', (s) => {
    expect(slugSchema.safeParse(s).success).toBe(false);
  });
});

describe('translated text', () => {
  it('accepts one language', () => {
    expect(i18nTextSchema.safeParse({ uz: 'Osh' }).success).toBe(true);
  });

  it('rejects an object with no language filled in', () => {
    expect(i18nTextSchema.safeParse({}).success).toBe(false);
    expect(i18nTextSchema.safeParse({ uz: '   ' }).success).toBe(false);
  });
});

describe('time', () => {
  it.each(['00:00', '09:30', '23:59'])('accepts %s', (t) => {
    expect(timeOfDaySchema.parse(t)).toBe(t);
  });

  it.each(['24:00', '9:30', '09:60', '0930'])('rejects %s', (t) => {
    expect(timeOfDaySchema.safeParse(t).success).toBe(false);
  });

  it('rejects a range that ends before it starts', () => {
    expect(timeRangeSchema.safeParse({ start: '18:00', end: '09:00' }).success).toBe(false);
    expect(timeRangeSchema.safeParse({ start: '09:00', end: '18:00' }).success).toBe(true);
  });

  it('requires ISO dates', () => {
    expect(dateOnlySchema.safeParse('17.09.2026').success).toBe(false);
    expect(dateOnlySchema.parse('2026-09-17')).toBe('2026-09-17');
  });
});

describe('pagination', () => {
  it('coerces query strings and applies defaults', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(paginationSchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('caps page size, so one request cannot ask for the whole table', () => {
    expect(paginationSchema.safeParse({ pageSize: 5000 }).success).toBe(false);
  });
});

describe('registration', () => {
  it('lowercases the email and defaults the language to Uzbek', () => {
    const parsed = registerSchema.parse({
      email: '  Owner@Anor.UZ ',
      password: 'olmalar bogida',
      firstName: 'Aziz',
    });
    expect(parsed.email).toBe('owner@anor.uz');
    expect(parsed.language).toBe('uz');
  });
});

describe('cart', () => {
  it('has no field for a price — the server prices every line (invariant I2)', () => {
    const parsed = addCartItemSchema.parse({ productId: ID, quantity: 2 });
    expect(parsed).not.toHaveProperty('price');
    expect(parsed.modifierOptionIds).toEqual([]);
  });

  it('strips an injected price instead of trusting it', () => {
    const parsed = addCartItemSchema.parse({ productId: ID, quantity: 1, price: 1 } as never);
    expect(parsed).not.toHaveProperty('price');
  });

  it('rejects a zero or negative quantity', () => {
    expect(addCartItemSchema.safeParse({ productId: ID, quantity: 0 }).success).toBe(false);
    expect(addCartItemSchema.safeParse({ productId: ID, quantity: -3 }).success).toBe(false);
  });
});

describe('checkout', () => {
  const base = { paymentMethod: 'CASH' as const, useLoyaltyAmount: 0 };

  it('requires an address for delivery', () => {
    expect(checkoutSchema.safeParse({ ...base, fulfillmentType: 'DELIVERY' }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({
        ...base,
        fulfillmentType: 'DELIVERY',
        address: { line1: 'Amir Temur 1' },
      }).success,
    ).toBe(true);
  });

  it('requires a branch for pickup and dine-in', () => {
    expect(checkoutSchema.safeParse({ ...base, fulfillmentType: 'PICKUP' }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...base, fulfillmentType: 'PICKUP', branchId: ID }).success,
    ).toBe(true);
  });

  it('carries no total — the client cannot state what it owes', () => {
    const parsed = checkoutSchema.parse({ ...base, fulfillmentType: 'PICKUP', branchId: ID });
    expect(parsed).not.toHaveProperty('total');
    expect(parsed).not.toHaveProperty('subtotal');
  });

  it('refuses a negative loyalty redemption', () => {
    // A negative redemption would add money to the order total.
    expect(
      checkoutSchema.safeParse({
        ...base,
        fulfillmentType: 'PICKUP',
        branchId: ID,
        useLoyaltyAmount: -5000,
      }).success,
    ).toBe(false);
  });
});

describe('booking', () => {
  it('requires a UTC instant, not a local wall-clock string', () => {
    // Uzbekistan is UTC+5 with no DST; accepting "2026-09-17 10:00" would book five
    // hours off and silently collide with another appointment.
    expect(
      createBookingSchema.safeParse({ serviceId: ID, startsAt: '2026-09-17 10:00' }).success,
    ).toBe(false);
    expect(
      createBookingSchema.safeParse({ serviceId: ID, startsAt: '2026-09-17T10:00:00.000Z' })
        .success,
    ).toBe(true);
  });

  it('rejects a non-uuid service id', () => {
    expect(
      createBookingSchema.safeParse({ serviceId: 'osh', startsAt: '2026-09-17T10:00:00.000Z' })
        .success,
    ).toBe(false);
  });

  it('has no field for a duration — the service defines it', () => {
    const parsed = createBookingSchema.parse({
      serviceId: ID,
      startsAt: '2026-09-17T10:00:00.000Z',
      durationMinutes: 5,
    } as never);
    expect(parsed).not.toHaveProperty('durationMinutes');
  });
});
