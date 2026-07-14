import { describe, expect, it } from "vitest";

import { type AdapterContractError, collectAllPages } from "./pagination.js";

describe("adapter pagination", () => {
  it("collects every page in provider order", async () => {
    const cursors: Array<string | null> = [];
    const items = await collectAllPages(async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? { cursor: "page-2", hasMore: true, items: [1, 2] }
        : { cursor: null, hasMore: false, items: [3] };
    });

    expect(items).toEqual([1, 2, 3]);
    expect(cursors).toEqual([null, "page-2"]);
  });

  it("fails instead of returning a provider's incomplete page", async () => {
    await expect(
      collectAllPages(async () => ({ cursor: null, hasMore: true, items: [1] })),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdapterContractError>>({
        code: "pagination.missing_cursor",
      }),
    );
  });

  it("rejects cursor loops", async () => {
    await expect(
      collectAllPages(async () => ({ cursor: "same", hasMore: true, items: [1] })),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdapterContractError>>({
        code: "pagination.cursor_loop",
      }),
    );
  });
});
