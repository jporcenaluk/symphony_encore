import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("persistence package", () => {
  it("identifies the durable SQLite boundary", () => {
    expect(componentName).toBe("persistence");
  });
});
