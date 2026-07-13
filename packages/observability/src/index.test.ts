import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("observability package", () => {
  it("identifies the log and event projection boundary", () => {
    expect(componentName).toBe("observability");
  });
});
