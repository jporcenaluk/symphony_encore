import { timingSafeEqual } from "node:crypto";
import {
  createOpaqueSessionSecrets,
  hashOpaqueSecret,
  type LocalPasswordVerifier,
  verifyLocalPassword,
} from "@symphony/adapters";
import {
  authenticateOperatorSession,
  createOperatorSession,
  loadLocalCredentialBySubject,
  type OpenedDatabase,
} from "@symphony/persistence";
import type { FastifyRequest } from "fastify";

import type { OperatorPrincipal } from "./control-api.js";

const SESSION_COOKIE = "symphony_session";
const DUMMY_VERIFIER: LocalPasswordVerifier = {
  algorithm: "scrypt",
  parameters: { N: 16_384, keyLength: 32, p: 1, r: 8 },
  salt: Buffer.alloc(16),
  verifier: Buffer.alloc(32),
};

export interface LocalSessionLogin {
  csrfToken: string;
  expiresAt: string;
  principal: OperatorPrincipal;
  sessionToken: string;
}

export function createLocalSessionAuth(input: {
  database: OpenedDatabase["database"];
  now?: () => Date;
  sessionTtlMs: number;
}) {
  const now = input.now ?? (() => new Date());

  async function readAuthenticatedSession(request: FastifyRequest) {
    const sessionToken = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (sessionToken === null) return null;
    return authenticateOperatorSession(input.database, {
      now: now().toISOString(),
      sessionTokenHash: hashOpaqueSecret(sessionToken),
    });
  }

  return {
    async authenticate(request: FastifyRequest): Promise<OperatorPrincipal | null> {
      const session = await readAuthenticatedSession(request);
      if (session === null) return null;
      return {
        authSubject: session.authSubject,
        capabilities: session.capabilities,
        operatorId: session.operatorId,
      };
    },

    async authenticateMutation(request: FastifyRequest): Promise<OperatorPrincipal | null> {
      const session = await readAuthenticatedSession(request);
      if (session === null || !isSameOrigin(request)) return null;
      const csrfToken = request.headers["x-csrf-token"];
      if (typeof csrfToken !== "string") return null;
      if (!constantTimeEqual(hashOpaqueSecret(csrfToken), session.csrfTokenHash)) return null;
      return {
        authSubject: session.authSubject,
        capabilities: session.capabilities,
        operatorId: session.operatorId,
      };
    },

    async login(credentials: {
      authSubject: string;
      password: string;
    }): Promise<LocalSessionLogin | null> {
      const stored = await loadLocalCredentialBySubject(input.database, credentials.authSubject);
      const verified = await verifyLocalPassword(credentials.password, stored ?? DUMMY_VERIFIER);
      if (stored === undefined || !verified) return null;

      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + input.sessionTtlMs);
      const secrets = createOpaqueSessionSecrets();
      await createOperatorSession(input.database, {
        authSubject: credentials.authSubject,
        csrfTokenHash: secrets.csrfTokenHash,
        expiresAt: expiresAt.toISOString(),
        issuedAt: issuedAt.toISOString(),
        operatorId: stored.operatorId,
        operatorVersion: stored.operatorVersion,
        sessionTokenHash: secrets.sessionTokenHash,
      });
      return {
        csrfToken: secrets.csrfToken,
        expiresAt: expiresAt.toISOString(),
        principal: {
          authSubject: credentials.authSubject,
          capabilities: stored.capabilities,
          operatorId: stored.operatorId,
        },
        sessionToken: secrets.sessionToken,
      };
    },
  };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  try {
    return decodeURIComponent(matches[0]?.slice(name.length + 1) ?? "") || null;
  } catch {
    return null;
  }
}

function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  return origin === `${request.protocol}://${host}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}
