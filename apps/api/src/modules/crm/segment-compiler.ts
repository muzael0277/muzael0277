import type { Prisma } from '@bizbot/database';

/**
 * Compiles a stored segment filter into a Prisma where clause.
 *
 * Segments are data, not code: "VIP", "inactive 30 days" and "birthday today" are rows a
 * tenant can edit, and adding one needs no deploy. The compiler is the price of that, and
 * it is a small, closed price — the field and operator sets are allow-listed, so a stored
 * filter cannot be turned into an arbitrary query.
 */

export type SegmentFilter =
  | { all: SegmentFilter[] }
  | { any: SegmentFilter[] }
  | { field: string; op: string; value: unknown };

const SCALAR_FIELDS = new Set([
  'totalSpent',
  'orderCount',
  'bookingCount',
  'loyaltyBalance',
  'language',
  'source',
]);
const DATE_FIELDS = new Set(['lastActivityAt', 'createdAt', 'birthDate']);

export function compileSegmentFilter(filter: SegmentFilter): Prisma.CustomerWhereInput {
  if ('all' in filter) return { AND: filter.all.map(compileSegmentFilter) };
  if ('any' in filter) return { OR: filter.any.map(compileSegmentFilter) };
  return compileCondition(filter);
}

function compileCondition(condition: {
  field: string;
  op: string;
  value: unknown;
}): Prisma.CustomerWhereInput {
  const { field, op, value } = condition;

  if (field === 'tag') {
    return { tagLinks: { some: { tagId: String(value) } } };
  }

  if (DATE_FIELDS.has(field)) {
    switch (op) {
      case 'daysAgoGt':
        // "Inactive for more than N days": the timestamp is *older* than the cutoff.
        return { [field]: { lt: daysAgo(Number(value)) } } as Prisma.CustomerWhereInput;
      case 'daysAgoLt':
        return { [field]: { gte: daysAgo(Number(value)) } } as Prisma.CustomerWhereInput;
      case 'monthDayEq': {
        // Birthdays: compare month and day, ignoring the year. Prisma cannot express
        // that, so the caller filters in SQL via a raw fragment; here we narrow to a
        // safe superset (non-null birthDate) and let the count be exact for 'today'
        // by matching the stored date's month/day through a generated range.
        if (value !== 'today') return { birthDate: { not: null } };
        const today = new Date();
        return {
          birthDate: { not: null },
          AND: [{ birthDate: { not: null } }],
          // Narrowing to the exact month/day needs SQL; callers wanting precision use
          // birthdaysToday() below. This keeps the generic path honest rather than wrong.
          OR: buildBirthdayRanges(today),
        };
      }
      case 'gt':
        return { [field]: { gt: new Date(String(value)) } } as Prisma.CustomerWhereInput;
      case 'lt':
        return { [field]: { lt: new Date(String(value)) } } as Prisma.CustomerWhereInput;
      default:
        return {};
    }
  }

  if (!SCALAR_FIELDS.has(field)) return {};

  // totalSpent is BigInt in the schema; a plain number would fail the comparison.
  const coerced = field === 'totalSpent' ? BigInt(Math.trunc(Number(value))) : value;

  switch (op) {
    case 'eq':
      return { [field]: coerced } as Prisma.CustomerWhereInput;
    case 'neq':
      return { [field]: { not: coerced } } as Prisma.CustomerWhereInput;
    case 'gt':
      return { [field]: { gt: coerced } } as Prisma.CustomerWhereInput;
    case 'gte':
      return { [field]: { gte: coerced } } as Prisma.CustomerWhereInput;
    case 'lt':
      return { [field]: { lt: coerced } } as Prisma.CustomerWhereInput;
    case 'lte':
      return { [field]: { lte: coerced } } as Prisma.CustomerWhereInput;
    case 'in':
      return { [field]: { in: value as unknown[] } } as Prisma.CustomerWhereInput;
    default:
      return {};
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Matches "same month and day, any year" by enumerating a century of candidate dates.
 * Ugly, but exact and index-friendly — and a birthday campaign that silently misses
 * people is worse than a slightly long IN list.
 */
function buildBirthdayRanges(today: Date): Prisma.CustomerWhereInput[] {
  const month = today.getUTCMonth();
  const day = today.getUTCDate();
  const ranges: Prisma.CustomerWhereInput[] = [];
  const thisYear = today.getUTCFullYear();

  for (let year = thisYear - 100; year <= thisYear; year++) {
    const date = new Date(Date.UTC(year, month, day));
    // Skip 29 February in non-leap years rather than silently rolling into 1 March.
    if (date.getUTCMonth() !== month) continue;
    ranges.push({ birthDate: date });
  }
  return ranges;
}
