import swagger from "@fastify/swagger";
import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  type ActiveServiceState,
  ConfigurationOverrideMutationResponseSchema,
  ConfigurationOverrideMutationSchema,
  ConfigurationOverrideParamsSchema,
  type ControlState,
  ControlStateSchema,
  ErrorEnvelopeSchema,
  type EventRecord,
  type EventRecordPage,
  EventRecordPageQuerySchema,
  EventRecordPageSchema,
  EventStreamHeadersSchema,
  EventStreamQuerySchema,
  HealthResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  ReadyResponseSchema,
} from "@symphony/contracts";
import Fastify, { type FastifyRequest } from "fastify";

import { encodeServerSentEvent, resolveEventResumeCursor } from "./event-stream.js";

export interface OperatorPrincipal {
  authSubject: string;
  capabilities: readonly string[];
  operatorId: string;
}

export interface ControlApiDependencies {
  authenticate(request: FastifyRequest): Promise<OperatorPrincipal | null>;
  authenticateMutation(request: FastifyRequest): Promise<OperatorPrincipal | null>;
  login(input: { authSubject: string; password: string }): Promise<{
    csrfToken: string;
    expiresAt: string;
    principal: OperatorPrincipal;
    sessionToken: string;
  } | null>;
  listEvents(input: { afterCursor: number; limit: number }): Promise<EventRecordPage>;
  mutateConfigurationOverride(input: {
    expectedVersion: number;
    idempotencyKey: string;
    key: string;
    operation: "set" | "clear";
    operator: OperatorPrincipal;
    reason: string;
    value?: unknown;
  }): Promise<{
    result: "accepted" | "idempotency_conflict" | "version_conflict" | "validation_failed";
    version: number;
  }>;
  readControlState(): Promise<ControlState>;
  readServiceStatus(): Promise<{ id: string; state: ActiveServiceState }>;
  sessionCookieSecure: boolean;
  streamEvents(input: { afterCursor: number; signal: AbortSignal }): AsyncIterable<EventRecord>;
}

export async function createControlApi(dependencies: ControlApiDependencies) {
  const server = Fastify({ logger: false })
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>();

  await server.register(swagger, {
    openapi: {
      components: {
        securitySchemes: {
          sessionCookie: { in: "cookie", name: "symphony_session", type: "apiKey" },
        },
      },
      info: { title: "Symphony Encore Control API", version: "0.0.0" },
      openapi: "3.1.0",
    },
  });

  server.setErrorHandler((error, _request, reply) => {
    const validationIssues = extractValidationIssues(error);
    if (
      validationIssues !== null ||
      (error instanceof Error && error.message === "events.invalid_cursor")
    ) {
      return reply.code(422).send({
        error: {
          code: "validation_failed",
          current_version: null,
          details: {
            issues: validationIssues ?? [],
          },
          message: "Request validation failed",
        },
      });
    }
    return reply.code(500).send({
      error: {
        code: "internal_error",
        current_version: null,
        details: {},
        message: "The request could not be completed",
      },
    });
  });

  server.get(
    "/health",
    {
      schema: {
        operationId: "getHealth",
        response: { 200: HealthResponseSchema },
        summary: "Process liveness",
        tags: ["service"],
      },
    },
    async () => {
      const status = await dependencies.readServiceStatus();
      return { service_state: status.state, status: "healthy" as const };
    },
  );

  server.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: LoginRequestSchema,
        operationId: "login",
        response: {
          200: LoginResponseSchema,
          401: ErrorEnvelopeSchema,
          422: ErrorEnvelopeSchema,
        },
        summary: "Create an authenticated operator session",
        tags: ["authentication"],
      },
    },
    async (request, reply) => {
      const login = await dependencies.login({
        authSubject: request.body.auth_subject,
        password: request.body.password,
      });
      reply.header("cache-control", "no-store");
      if (login === null) {
        return reply.code(401).send({
          error: {
            code: "invalid_credentials",
            current_version: null,
            details: {},
            message: "The supplied credentials are invalid",
          },
        });
      }
      reply.header(
        "set-cookie",
        serializeSessionCookie(
          login.sessionToken,
          login.expiresAt,
          dependencies.sessionCookieSecure,
        ),
      );
      return reply.code(200).send({
        csrf_token: login.csrfToken,
        expires_at: login.expiresAt,
        operator: {
          auth_subject: login.principal.authSubject,
          capabilities: [...login.principal.capabilities],
          operator_id: login.principal.operatorId,
        },
      });
    },
  );

  server.put(
    "/api/v1/config/overrides/:key",
    {
      schema: {
        body: ConfigurationOverrideMutationSchema,
        operationId: "mutateConfigurationOverride",
        params: ConfigurationOverrideParamsSchema,
        response: {
          200: ConfigurationOverrideMutationResponseSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          409: ConfigurationOverrideMutationResponseSchema,
          422: Type.Union([ConfigurationOverrideMutationResponseSchema, ErrorEnvelopeSchema]),
          503: ErrorEnvelopeSchema,
        },
        security: [{ sessionCookie: [] }],
        summary: "Set or clear a durable configuration override",
        tags: ["control"],
      },
    },
    async (request, reply) => {
      const authenticated = await dependencies.authenticate(request);
      if (authenticated === null) {
        return reply.code(401).send({
          error: {
            code: "authentication_required",
            current_version: null,
            details: {},
            message: "Authentication is required",
          },
        });
      }
      if (!authenticated.capabilities.includes("config.write")) {
        return reply.code(403).send({
          error: {
            code: "capability_required",
            current_version: null,
            details: { capability: "config.write" },
            message: "The config.write capability is required",
          },
        });
      }
      const mutationOperator = await dependencies.authenticateMutation(request);
      if (
        mutationOperator === null ||
        mutationOperator.operatorId !== authenticated.operatorId ||
        mutationOperator.authSubject !== authenticated.authSubject
      ) {
        return reply.code(403).send({
          error: {
            code: "csrf_failed",
            current_version: null,
            details: {},
            message: "Same-origin CSRF verification failed",
          },
        });
      }

      const controlState = await dependencies.readControlState();
      if (!controlState.mutations_enabled) {
        return reply.code(503).send({
          error: {
            code: "mutations_disabled",
            current_version: controlState.version,
            details: { service_state: controlState.service_run.status },
            message: "Control mutations are disabled until recovery completes",
          },
        });
      }

      const result = await dependencies.mutateConfigurationOverride({
        expectedVersion: request.body.expected_version,
        idempotencyKey: request.body.idempotency_key,
        key: request.params.key,
        operation: request.body.operation,
        operator: mutationOperator,
        reason: request.body.reason,
        ...(request.body.operation === "set" ? { value: request.body.value } : {}),
      });
      const status =
        result.result === "accepted" ? 200 : result.result === "validation_failed" ? 422 : 409;
      return reply.code(status).send(result);
    },
  );

  server.get(
    "/ready",
    {
      schema: {
        operationId: "getReady",
        response: { 200: ReadyResponseSchema, 503: ErrorEnvelopeSchema },
        summary: "Service readiness",
        tags: ["service"],
      },
    },
    async (_request, reply) => {
      const status = await dependencies.readServiceStatus();
      if (status.state === "ready") {
        return reply.code(200).send({ service_run_id: status.id, status: "ready" });
      }
      return reply.code(503).send({
        error: {
          code: "service_not_ready",
          current_version: status.id,
          details: { service_state: status.state },
          message:
            status.state === "recovering"
              ? "Service recovery is still in progress"
              : "Service is not ready",
        },
      });
    },
  );

  server.get(
    "/api/v1/events/stream",
    {
      schema: {
        headers: EventStreamHeadersSchema,
        operationId: "streamEvents",
        produces: ["text/event-stream"],
        querystring: EventStreamQuerySchema,
        response: {
          200: { type: "string" },
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          422: ErrorEnvelopeSchema,
        },
        security: [{ sessionCookie: [] }],
        summary: "Live durable event stream",
        tags: ["control"],
      },
    },
    async (request, reply) => {
      const operator = await dependencies.authenticate(request);
      if (operator === null) {
        return reply.code(401).send({
          error: {
            code: "authentication_required",
            current_version: null,
            details: {},
            message: "Authentication is required",
          },
        });
      }
      if (!operator.capabilities.includes("operator.read")) {
        return reply.code(403).send({
          error: {
            code: "capability_required",
            current_version: null,
            details: { capability: "operator.read" },
            message: "The operator.read capability is required",
          },
        });
      }

      const afterCursor = resolveEventResumeCursor({
        explicit:
          request.query.after_cursor === undefined ? undefined : String(request.query.after_cursor),
        lastEventId: request.headers["last-event-id"],
      });
      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      try {
        for await (const record of dependencies.streamEvents({
          afterCursor,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          reply.raw.write(encodeServerSentEvent(record));
        }
      } finally {
        controller.abort();
        reply.raw.end();
      }
      return reply;
    },
  );

  server.get(
    "/api/v1/events",
    {
      schema: {
        operationId: "listEvents",
        querystring: EventRecordPageQuerySchema,
        response: {
          200: EventRecordPageSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
          422: ErrorEnvelopeSchema,
        },
        security: [{ sessionCookie: [] }],
        summary: "Durable event page",
        tags: ["control"],
      },
    },
    async (request, reply) => {
      const operator = await dependencies.authenticate(request);
      if (operator === null) {
        return reply.code(401).send({
          error: {
            code: "authentication_required",
            current_version: null,
            details: {},
            message: "Authentication is required",
          },
        });
      }
      if (!operator.capabilities.includes("operator.read")) {
        return reply.code(403).send({
          error: {
            code: "capability_required",
            current_version: null,
            details: { capability: "operator.read" },
            message: "The operator.read capability is required",
          },
        });
      }
      return reply.code(200).send(
        await dependencies.listEvents({
          afterCursor: request.query.after_cursor ?? 0,
          limit: request.query.limit ?? 100,
        }),
      );
    },
  );

  server.get(
    "/api/v1/state",
    {
      schema: {
        operationId: "getControlState",
        response: {
          200: ControlStateSchema,
          401: ErrorEnvelopeSchema,
          403: ErrorEnvelopeSchema,
        },
        security: [{ sessionCookie: [] }],
        summary: "Current orchestrator state",
        tags: ["control"],
      },
    },
    async (request, reply) => {
      const operator = await dependencies.authenticate(request);
      if (operator === null) {
        return reply.code(401).send({
          error: {
            code: "authentication_required",
            current_version: null,
            details: {},
            message: "Authentication is required",
          },
        });
      }
      if (!operator.capabilities.includes("operator.read")) {
        return reply.code(403).send({
          error: {
            code: "capability_required",
            current_version: null,
            details: { capability: "operator.read" },
            message: "The operator.read capability is required",
          },
        });
      }
      return reply.code(200).send(await dependencies.readControlState());
    },
  );

  return server;
}

function serializeSessionCookie(token: string, expiresAt: string, secure: boolean): string {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) throw new Error("auth.invalid_session_expiry");
  return [
    `symphony_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export type ControlApi = Awaited<ReturnType<typeof createControlApi>>;

function extractValidationIssues(
  error: unknown,
): { instance_path: string; keyword: string; message: string }[] | null {
  if (typeof error !== "object" || error === null || !("validation" in error)) return null;
  const validation = error.validation;
  if (!Array.isArray(validation)) return null;
  return validation.map((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) {
      return { instance_path: "", keyword: "validation", message: "invalid value" };
    }
    return {
      instance_path:
        "instancePath" in issue && typeof issue.instancePath === "string" ? issue.instancePath : "",
      keyword:
        "keyword" in issue && typeof issue.keyword === "string" ? issue.keyword : "validation",
      message:
        "message" in issue && typeof issue.message === "string" ? issue.message : "invalid value",
    };
  });
}
