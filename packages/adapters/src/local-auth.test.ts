import { describe, expect, it } from "vitest";

import {
  createOpaqueSessionSecrets,
  hashLocalPassword,
  hashOpaqueSecret,
  verifyLocalPassword,
} from "./local-auth.js";

describe("local authentication cryptography", () => {
  it("stores a salted scrypt verifier and compares passwords in constant-time form", async () => {
    const verifier = await hashLocalPassword("correct horse battery staple");

    expect(verifier.algorithm).toBe("scrypt");
    expect(verifier.salt).toBeInstanceOf(Buffer);
    expect(verifier.verifier).toBeInstanceOf(Buffer);
    expect(verifier.verifier.toString("utf8")).not.toContain("correct horse");
    await expect(verifyLocalPassword("correct horse battery staple", verifier)).resolves.toBe(true);
    await expect(verifyLocalPassword("incorrect", verifier)).resolves.toBe(false);
  });

  it("returns opaque session and CSRF secrets while exposing only their hashes for storage", () => {
    const secrets = createOpaqueSessionSecrets();

    expect(secrets.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(secrets.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(secrets.sessionToken).not.toBe(secrets.csrfToken);
    expect(secrets.sessionTokenHash).toBe(hashOpaqueSecret(secrets.sessionToken));
    expect(secrets.csrfTokenHash).toBe(hashOpaqueSecret(secrets.csrfToken));
    expect(secrets.sessionTokenHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
