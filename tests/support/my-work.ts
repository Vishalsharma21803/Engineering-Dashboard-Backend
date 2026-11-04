/** A grouped My work page's ticket rows, in the order shown (each group's heading row, then its rows). */
export function myWorkRows<T>(page: { items: Array<{ headingRow: T | null; rows: T[] }> }): T[] {
  return page.items.flatMap((group) => [...(group.headingRow ? [group.headingRow] : []), ...group.rows]);
}
