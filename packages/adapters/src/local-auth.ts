import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_PARAMETERS = { N: 16_384, p: 1, r: 8 } as const;
const SCRYPT_KEY_LENGTH = 32;

export interface LocalPasswordVerifier {
  algorithm: "scrypt";
  parameters: { N: number; keyLength: number; p: number; r: number };
  salt: Buffer;
  verifier: Buffer;
}

export async function hashLocalPassword(password: string): Promise<LocalPasswordVerifier> {
  if (password.length === 0) throw new Error("auth.password_empty");
  const salt = randomBytes(16);
  const verifier = await deriveScrypt(password, salt, SCRYPT_PARAMETERS, SCRYPT_KEY_LENGTH);
  return {
    algorithm: "scrypt",
    parameters: { ...SCRYPT_PARAMETERS, keyLength: SCRYPT_KEY_LENGTH },
    salt,
    verifier,
  };
}

export async function verifyLocalPassword(
  password: string,
  stored: LocalPasswordVerifier,
): Promise<boolean> {
  if (stored.algorithm !== "scrypt" || stored.verifier.byteLength !== stored.parameters.keyLength) {
    throw new Error("auth.invalid_verifier");
  }
  const candidate = await deriveScrypt(
    password,
    stored.salt,
    { N: stored.parameters.N, p: stored.parameters.p, r: stored.parameters.r },
    stored.parameters.keyLength,
  );
  return timingSafeEqual(candidate, stored.verifier);
}

export function hashOpaqueSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

export function createOpaqueSessionSecrets(): {
  csrfToken: string;
  csrfTokenHash: string;
  sessionToken: string;
  sessionTokenHash: string;
} {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  return {
    csrfToken,
    csrfTokenHash: hashOpaqueSecret(csrfToken),
    sessionToken,
    sessionTokenHash: hashOpaqueSecret(sessionToken),
  };
}

async function deriveScrypt(
  password: string,
  salt: Buffer,
  parameters: { N: number; p: number; r: number },
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, parameters, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}
