import swagger from "@fastify/swagger";
import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import {
  type ActiveServiceState,
  type ControlState,
  ControlStateSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
} from "@symphony/contracts";
import Fastify, { type FastifyRequest } from "fastify";

export interface OperatorPrincipal {
  authSubject: string;
  capabilities: readonly string[];
  operatorId: string;
}

export interface ControlApiDependencies {
  authenticate(request: FastifyRequest): Promise<OperatorPrincipal | null>;
  readControlState(): Promise<ControlState>;
  readServiceStatus(): Promise<{ id: string; state: ActiveServiceState }>;
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

export type ControlApi = Awaited<ReturnType<typeof createControlApi>>;
