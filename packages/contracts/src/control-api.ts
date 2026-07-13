import { type Static, Type } from "@sinclair/typebox";

import { EventRecordSchema } from "./entity-records.js";

const NonEmptyString = Type.String({ minLength: 1 });

export const ActiveServiceStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("recovering"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);
export type ActiveServiceState = Static<typeof ActiveServiceStateSchema>;

export const ErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: NonEmptyString,
        current_version: Type.Union([NonEmptyString, Type.Null()]),
        details: Type.Record(Type.String(), Type.Unknown()),
        message: NonEmptyString,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const HealthResponseSchema = Type.Object(
  {
    service_state: ActiveServiceStateSchema,
    status: Type.Literal("healthy"),
  },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadyResponseSchema = Type.Object(
  {
    service_run_id: NonEmptyString,
    status: Type.Literal("ready"),
  },
  { additionalProperties: false },
);
export type ReadyResponse = Static<typeof ReadyResponseSchema>;

export const BootstrapStatusResponseSchema = Type.Object(
  {
    candidate_hash: NonEmptyString,
    status: Type.Literal("required"),
  },
  { additionalProperties: false },
);
export type BootstrapStatusResponse = Static<typeof BootstrapStatusResponseSchema>;

export const BootstrapRequestSchema = Type.Object(
  {
    auth_subject: Type.String({ maxLength: 512, minLength: 1 }),
    bootstrap_credential: Type.String({ maxLength: 4096, minLength: 1 }),
    confirmed_candidate_hash: Type.String({ maxLength: 256, minLength: 1 }),
    password: Type.String({ maxLength: 4096, minLength: 12 }),
    tracker_login: Type.Union([Type.String({ maxLength: 512, minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type BootstrapRequest = Static<typeof BootstrapRequestSchema>;

export const BootstrapResponseSchema = Type.Object(
  { status: Type.Literal("completed") },
  { additionalProperties: false },
);
export type BootstrapResponse = Static<typeof BootstrapResponseSchema>;

export const LoginRequestSchema = Type.Object(
  {
    auth_subject: Type.String({ maxLength: 512, minLength: 1 }),
    password: Type.String({ maxLength: 4096, minLength: 1 }),
  },
  { additionalProperties: false },
);
export type LoginRequest = Static<typeof LoginRequestSchema>;

export const LoginResponseSchema = Type.Object(
  {
    csrf_token: NonEmptyString,
    expires_at: NonEmptyString,
    operator: Type.Object(
      {
        auth_subject: NonEmptyString,
        capabilities: Type.Array(NonEmptyString, { uniqueItems: true }),
        operator_id: NonEmptyString,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type LoginResponse = Static<typeof LoginResponseSchema>;

export const ConfigurationOverrideParamsSchema = Type.Object(
  {
    key: Type.String({
      maxLength: 256,
      minLength: 3,
      pattern: "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$",
    }),
  },
  { additionalProperties: false },
);
export type ConfigurationOverrideParams = Static<typeof ConfigurationOverrideParamsSchema>;

const ConfigurationMutationEnvelope = {
  expected_version: Type.Integer({ minimum: 0 }),
  idempotency_key: Type.String({ maxLength: 256, minLength: 1 }),
  reason: Type.String({ maxLength: 2000, minLength: 1 }),
};

export const ConfigurationOverrideMutationSchema = Type.Union([
  Type.Object(
    {
      ...ConfigurationMutationEnvelope,
      operation: Type.Literal("set"),
      value: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...ConfigurationMutationEnvelope, operation: Type.Literal("clear") },
    { additionalProperties: false },
  ),
]);
export type ConfigurationOverrideMutation = Static<typeof ConfigurationOverrideMutationSchema>;

export const ConfigurationOverrideMutationResponseSchema = Type.Object(
  {
    result: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("idempotency_conflict"),
      Type.Literal("version_conflict"),
      Type.Literal("validation_failed"),
    ]),
    version: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ConfigurationOverrideMutationResponse = Static<
  typeof ConfigurationOverrideMutationResponseSchema
>;

export const ControlStateSchema = Type.Object(
  {
    dispatch_enabled: Type.Boolean(),
    mutations_enabled: Type.Boolean(),
    service_run: Type.Object(
      {
        id: NonEmptyString,
        service_version: NonEmptyString,
        started_at: NonEmptyString,
        status: ActiveServiceStateSchema,
      },
      { additionalProperties: false },
    ),
    version: NonEmptyString,
  },
  { additionalProperties: false },
);
export type ControlState = Static<typeof ControlStateSchema>;

export const EventRecordPageQuerySchema = Type.Object(
  {
    after_cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ maximum: 1000, minimum: 1 })),
  },
  { additionalProperties: false },
);
export type EventRecordPageQuery = Static<typeof EventRecordPageQuerySchema>;

export const EventRecordPageSchema = Type.Object(
  {
    has_more: Type.Boolean(),
    items: Type.Array(EventRecordSchema),
    next_cursor: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type EventRecordPage = Static<typeof EventRecordPageSchema>;

export const EventStreamQuerySchema = Type.Object(
  { after_cursor: Type.Optional(Type.Integer({ minimum: 0 })) },
  { additionalProperties: false },
);
export type EventStreamQuery = Static<typeof EventStreamQuerySchema>;

export const EventStreamHeadersSchema = Type.Object({
  "last-event-id": Type.Optional(Type.String({ pattern: "^(?:0|[1-9][0-9]*)$" })),
});
export type EventStreamHeaders = Static<typeof EventStreamHeadersSchema>;
