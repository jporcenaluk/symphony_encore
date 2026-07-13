import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("immutable publication policy", () => {
  it("publishes only a successful protected-main CI commit by SHA", async () => {
    const source = await readFile(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(source).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(source).toContain("needs: [required]");
    expect(source).toContain("tags: $" + "{{ env.IMAGE }}:sha-$" + "{{ env.SHA }}");
    expect(source).toContain("subject-checksums: artifacts/checksums.txt");
  });

  it("promotes the existing commit image and never rebuilds a release", async () => {
    const source = await readFile(
      path.join(process.cwd(), ".github/workflows/release.yml"),
      "utf8",
    );
    expect(source).toContain("docker buildx imagetools create");
    expect(source).toContain('"$' + "{IMAGE}:sha-$" + '{SHA}"');
    expect(source).not.toContain("docker/build-push-action");
    expect(source).not.toMatch(/docker\s+build\s/u);
    expect(source).toContain("sha256sum --check checksums.txt");
  });
});
