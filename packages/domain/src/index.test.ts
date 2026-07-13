import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("domain package", () => {
  it("identifies the dependency-free policy boundary", () => {
    expect(componentName).toBe("domain");
  });
});
