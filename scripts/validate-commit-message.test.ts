import { describe, expect, it } from "vitest";

import { isValidCommitMessage } from "./validate-commit-message.js";

describe("commit message policy", () => {
  it("accepts the repository Conventional Commit subset", () => {
    expect(isValidCommitMessage("feat(config): load workflow\n\nDetails")).toBe(true);
    expect(isValidCommitMessage("fix!: close unsafe boundary")).toBe(true);
  });

  it("rejects unscoped prose and invalid scopes", () => {
    expect(isValidCommitMessage("Update workflow")).toBe(false);
    expect(isValidCommitMessage("feat(Bad Scope): update")).toBe(false);
  });
});
