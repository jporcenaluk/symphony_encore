import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("test-support package", () => {
  it("identifies the shared fixture boundary", () => {
    expect(componentName).toBe("test-support");
  });
});
