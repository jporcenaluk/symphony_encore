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
