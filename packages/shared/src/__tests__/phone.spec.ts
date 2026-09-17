import { describe, it, expect } from 'vitest';
import { parseUzPhone, formatUzPhone, isValidUzPhone, maskPhone } from '../phone';

describe('parseUzPhone', () => {
  it('normalizes every format a customer might type', () => {
    const expected = '998901234567';
    for (const input of [
      '+998 90 123 45 67',
      '998901234567',
      '901234567',
      '90 123-45-67',
      '+998901234567',
      '8998901234567',
      '(90) 123 45 67',
    ]) {
      expect(parseUzPhone(input)?.e164, input).toBe(expected);
    }
  });

  it('rejects numbers with an unissued operator code', () => {
    expect(parseUzPhone('998121234567')).toBeNull(); // 12 is not an operator code
    expect(isValidUzPhone('+998 12 123 45 67')).toBe(false);
  });

  it('rejects wrong-length input instead of padding it', () => {
    expect(parseUzPhone('90123')).toBeNull();
    expect(parseUzPhone('9989012345678')).toBeNull();
  });
});

describe('formatUzPhone', () => {
  it('renders the Uzbek display convention', () => {
    expect(formatUzPhone('998901234567')).toBe('+998 90 123 45 67');
  });

  it('returns the input untouched when it cannot be parsed', () => {
    expect(formatUzPhone('garbage')).toBe('garbage');
  });
});

describe('maskPhone', () => {
  it('hides the middle digits for logs and screenshots', () => {
    expect(maskPhone('998901234567')).toBe('+998 90 *** ** 67');
  });
});
