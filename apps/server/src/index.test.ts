import { describe, expect, it } from "vitest";

import { componentName } from "./index.js";

describe("server package", () => {
  it("identifies the daemon boundary", () => {
    expect(componentName).toBe("server");
  });
});
