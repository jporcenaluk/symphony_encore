import { describe, expect, it } from "vitest";

import { GITLEAKS_VERSION, selectGitleaksArtifact } from "./install-gitleaks.js";

describe("pinned Gitleaks installer", () => {
  it("selects checksum-pinned Linux and macOS artifacts", () => {
    expect(GITLEAKS_VERSION).toBe("8.30.1");
    expect(selectGitleaksArtifact("linux", "x64")).toEqual({
      archive: "gitleaks_8.30.1_linux_x64.tar.gz",
      sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    });
    expect(selectGitleaksArtifact("darwin", "arm64").sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed on an unsupported host", () => {
    expect(() => selectGitleaksArtifact("win32", "x64")).toThrow(
      "gitleaks.unsupported_host:win32:x64",
    );
  });
});
