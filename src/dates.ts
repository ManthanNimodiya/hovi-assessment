// Calendar dates are kept as 'YYYY-MM-DD' strings. Such strings compare correctly with < and >,
// but only if they are real dates, so every date from a user goes through isRealDate first.
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const today = () => new Date().toISOString().slice(0, 10);

/** The day `days` days from today (negative = in the past). */
export const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * True only for a real calendar day. The round trip matters: JavaScript quietly turns
 * '2026-02-31' into 3 March, so a regex plus Date.parse is not enough.
 */
export function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Same day, `years` later (for comparisons only; 29 Feb stays 29 Feb). */
export const addYears = (date: string, years: number) => `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;
