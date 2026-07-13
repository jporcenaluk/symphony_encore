import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("orchestration package", () => {
  it("identifies the scheduler boundary", () => {
    expect(componentName).toBe("orchestration");
  });
});
