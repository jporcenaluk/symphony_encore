export interface AdapterPage<T> {
  cursor: string | null;
  hasMore: boolean;
  items: readonly T[];
}

export type PaginationContractErrorCode = "pagination.missing_cursor" | "pagination.cursor_loop";

export class AdapterContractError extends Error {
  readonly code: PaginationContractErrorCode;

  constructor(code: PaginationContractErrorCode) {
    super(code);
    this.name = "AdapterContractError";
    this.code = code;
  }
}

export async function collectAllPages<T>(
  fetchPage: (cursor: string | null) => Promise<AdapterPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.cursor === null) {
      throw new AdapterContractError("pagination.missing_cursor");
    }
    if (seenCursors.has(page.cursor)) {
      throw new AdapterContractError("pagination.cursor_loop");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
}
