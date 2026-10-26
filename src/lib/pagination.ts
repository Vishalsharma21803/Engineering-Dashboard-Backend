/** Every paged list shows this many rows. Fixed on the server so it cannot be raised from the browser. */
export const PAGE_SIZE = 10;

/** Upper bound for a requested page number; anything beyond is clamped to the last page anyway. */
const MAX_PAGE_DIGITS = 6;

export interface Page<T> {
  items: T[];
  /** The page actually served (requested page clamped into 1..totalPages). */
  page: number;
  pageSize: number;
  total: number;
  /** At least 1, so an empty list still has a page 1. */
  totalPages: number;
}

/**
 * Tamper-safe page number from a query value: anything that is not a plain
 * positive integer (missing, text, 0, negative, decimals, arrays, huge) is page 1.
 */
export function pageParam(value: unknown): number {
  if (typeof value !== "string" || !new RegExp(`^\\d{1,${MAX_PAGE_DIGITS}}$`).test(value)) {
    return 1;
  }

  return Math.max(1, Number(value));
}

/** Slices one page; a page past the end becomes the last page. */
export function paginate<T>(items: T[], requestedPage: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);

  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages };
}
