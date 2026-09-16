/**
 * Uzbek phone numbers.
 *
 * Canonical storage form is E.164 without the plus: "998901234567".
 * Display form is "+998 90 123 45 67", which is how every Uzbek business writes it.
 */

const UZ_COUNTRY_CODE = '998';

/** Mobile operator codes currently issued in Uzbekistan. */
const UZ_OPERATOR_CODES = [
  '20', '33', '50', '55', '61', '62', '63', '65', '66', '67', '69',
  '70', '71', '72', '73', '74', '75', '76', '77', '78', '79',
  '88', '90', '91', '93', '94', '95', '97', '98', '99',
];

export interface ParsedPhone {
  /** E.164 without "+", e.g. 998901234567 */
  e164: string;
  countryCode: string;
  operatorCode: string;
  subscriber: string;
}

/**
 * Normalizes any of "+998 90 123 45 67", "998901234567", "901234567", "90 123-45-67"
 * into the canonical form. Returns null when the number is not a valid Uzbek number,
 * so callers must decide what to do rather than storing garbage.
 */
export function parseUzPhone(input: string): ParsedPhone | null {
  const digits = input.replace(/\D/g, '');
  let national: string;

  if (digits.length === 12 && digits.startsWith(UZ_COUNTRY_CODE)) {
    national = digits.slice(3);
  } else if (digits.length === 9) {
    national = digits;
  } else if (digits.length === 13 && digits.startsWith('8' + UZ_COUNTRY_CODE)) {
    national = digits.slice(4);
  } else {
    return null;
  }

  const operatorCode = national.slice(0, 2);
  if (!UZ_OPERATOR_CODES.includes(operatorCode)) return null;

  return {
    e164: UZ_COUNTRY_CODE + national,
    countryCode: UZ_COUNTRY_CODE,
    operatorCode,
    subscriber: national.slice(2),
  };
}

export function isValidUzPhone(input: string): boolean {
  return parseUzPhone(input) !== null;
}

/** "998901234567" -> "+998 90 123 45 67" */
export function formatUzPhone(e164: string): string {
  const parsed = parseUzPhone(e164);
  if (!parsed) return e164;
  const s = parsed.subscriber;
  return `+${parsed.countryCode} ${parsed.operatorCode} ${s.slice(0, 3)} ${s.slice(3, 5)} ${s.slice(5, 7)}`;
}

/** Masks a number for logs and screenshots: "+998 90 *** ** 67" */
export function maskPhone(e164: string): string {
  const parsed = parseUzPhone(e164);
  if (!parsed) return '***';
  const s = parsed.subscriber;
  return `+${parsed.countryCode} ${parsed.operatorCode} *** ** ${s.slice(5, 7)}`;
}
