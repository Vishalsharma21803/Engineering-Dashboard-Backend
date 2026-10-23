const DAY_MS = 24 * 60 * 60 * 1000;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/** Whole Monday–Friday days elapsed between two instants (UTC). */
export function workingDaysBetween(from: Date, to: Date): number {
  if (to <= from) {
    return 0;
  }

  let count = 0;
  let cursor = new Date(from.getTime() + DAY_MS);

  while (cursor <= to) {
    if (!isWeekend(cursor)) {
      count += 1;
    }

    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  return count;
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (60 * 60 * 1000);
}
