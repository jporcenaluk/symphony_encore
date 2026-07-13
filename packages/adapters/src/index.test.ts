import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("adapters package", () => {
  it("identifies the external provider boundary", () => {
    expect(componentName).toBe("adapters");
  });
});
