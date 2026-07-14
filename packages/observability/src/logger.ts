import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const REDACTED = "[Redacted]";
const SECRET_FIELD_NAMES = new Set([
  "access_token",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "csrf_token",
  "diff",
  "password",
  "prompt",
  "raw_diff",
  "raw_prompt",
  "refresh_token",
  "secret",
  "session_secret",
  "session_token",
  "token",
]);

export interface RootLoggerOptions {
  destination?: DestinationStream;
  level?: LoggerOptions["level"];
}

export function createRootLogger(options: RootLoggerOptions = {}): Logger {
  return pino(
    {
      formatters: {
        log(object) {
          return scrubRecord(object);
        },
      },
      level: options.level ?? "info",
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    options.destination,
  );
}

export function createComponentLogger(
  root: Logger,
  component: string,
  bindings: Readonly<Record<string, string | number | boolean | null>> = {},
): Logger {
  return root.child({ component, ...bindings });
}

export function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(record, new WeakSet<object>()) as Record<string, unknown>;
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen));

  const scrubbed: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    scrubbed[key] = SECRET_FIELD_NAMES.has(normalizeFieldName(key))
      ? REDACTED
      : scrubValue(nested, seen);
  }
  return scrubbed;
}

function normalizeFieldName(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .toLowerCase();
}
