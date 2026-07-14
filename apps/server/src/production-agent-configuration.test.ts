import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { pathFromRoot, rulesBlock } from "./production-agent-configuration.js";

describe("production agent configuration helpers", () => {
  it("keeps prompt and path normalization outside the production scheduler", async () => {
    const scheduler = await readFile(new URL("./production-scheduler.ts", import.meta.url), "utf8");

    expect(scheduler).toContain('from "./production-agent-configuration.js";');
    expect(scheduler).not.toContain("function rulesBlock(");
    expect(scheduler).not.toContain("function pathFromRoot(");
  });

  it("extracts and trims the first complete rules block", () => {
    expect(rulesBlock("before <!-- rules:start -->\n keep me \n<!-- rules:end --> after")).toBe(
      "keep me",
    );
    expect(rulesBlock("<!-- rules:end --><!-- rules:start -->incomplete")).toBe("");
  });

  it("rejects repeated unterminated rule markers in bounded time", () => {
    expect(rulesBlock("<!-- rules:start -->".repeat(15_000))).toBe("");
  }, 250);

  it("removes only trailing root separators", () => {
    expect(pathFromRoot("/srv/symphony///", ".agents/skills")).toBe("/srv/symphony/.agents/skills");
    expect(pathFromRoot("///", ".agents/skills")).toBe("/.agents/skills");
  });

  it("leaves repeated non-trailing separators unchanged in bounded time", () => {
    const root = `${"/".repeat(30_000)}x`;

    expect(pathFromRoot(root, ".agents/skills")).toBe(`${root}/.agents/skills`);
  }, 250);
});
