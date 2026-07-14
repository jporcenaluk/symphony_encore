import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("contracts package", () => {
  it("identifies the language-neutral wire boundary", () => {
    expect(componentName).toBe("contracts");
  });
});
