import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./app.js";

describe("operator console shell", () => {
  it("shows recovery state without inventing orchestration data", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Symphony Encore");
    expect(markup).toContain("Control plane foundation in progress");
    expect(markup).toContain("Live operational data appears only after durable API records exist.");
    expect(markup).not.toContain("$0.00");
  });
});
