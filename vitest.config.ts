import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    passWithNoTests: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
