import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("web package", () => {
  it("identifies the operator UI boundary", () => {
    expect(componentName).toBe("web");
  });
});
