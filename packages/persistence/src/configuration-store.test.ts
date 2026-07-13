import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadActiveOverrides, mutateConfigurationOverride } from "./configuration-store.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-config-store-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database, undefined, () => "2026-07-13T10:00:00Z");
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const setRequest = {
  actionId: "action-1",
  authSubject: "local:admin",
  capability: "config.write",
  createdAt: "2026-07-13T10:01:00Z",
  endpoint: "/api/configuration/overrides",
  expectedVersion: 0,
  idempotencyKey: "request-1",
  key: "polling.interval_ms",
  operation: "set" as const,
  operatorId: "admin",
  reason: "Faster local feedback",
  requestPayloadHash: "sha256:payload-1",
  validationError: null,
  value: 5_000,
};

describe("durable configuration overrides", () => {
  it("creates an override and returns the original result on an identical replay", async () => {
    const first = await mutateConfigurationOverride(opened.database, setRequest);
    const replay = await mutateConfigurationOverride(opened.database, {
      ...setRequest,
      actionId: "action-replay",
    });

    expect(first).toEqual({ result: "accepted", version: 1 });
    expect(replay).toEqual(first);
    expect(await loadActiveOverrides(opened.database)).toEqual([
      { key: "polling.interval_ms", value: 5_000, version: 1 },
    ]);
    expect(opened.sqlite.prepare("select count(*) as count from operator_actions").get()).toEqual({
      count: 1,
    });
  });

  it("audits conflicting idempotency-key reuse without changing the override", async () => {
    await mutateConfigurationOverride(opened.database, setRequest);

    const conflict = await mutateConfigurationOverride(opened.database, {
      ...setRequest,
      actionId: "action-2",
      requestPayloadHash: "sha256:different-payload",
      value: 6_000,
    });

    expect(conflict).toEqual({ result: "idempotency_conflict", version: 1 });
    expect(await loadActiveOverrides(opened.database)).toEqual([
      { key: "polling.interval_ms", value: 5_000, version: 1 },
    ]);
    expect(
      opened.sqlite
        .prepare("select id, result from operator_actions order by created_at, id")
        .all(),
    ).toEqual([
      { id: "action-1", result: "accepted" },
      { id: "action-2", result: "idempotency_conflict" },
    ]);
  });

  it("audits stale versions and invalid candidates before returning", async () => {
    await mutateConfigurationOverride(opened.database, setRequest);

    expect(
      await mutateConfigurationOverride(opened.database, {
        ...setRequest,
        actionId: "action-stale",
        idempotencyKey: "request-stale",
        requestPayloadHash: "sha256:stale",
        value: 7_000,
      }),
    ).toEqual({ result: "version_conflict", version: 1 });
    expect(
      await mutateConfigurationOverride(opened.database, {
        ...setRequest,
        actionId: "action-invalid",
        expectedVersion: 1,
        idempotencyKey: "request-invalid",
        requestPayloadHash: "sha256:invalid",
        validationError: "config.must_be_positive",
        value: -1,
      }),
    ).toEqual({ result: "validation_failed", version: 1 });
    expect(opened.sqlite.prepare("select count(*) as count from operator_actions").get()).toEqual({
      count: 3,
    });
  });

  it("appends a clear operation without deleting override history", async () => {
    await mutateConfigurationOverride(opened.database, setRequest);
    expect(
      await mutateConfigurationOverride(opened.database, {
        ...setRequest,
        actionId: "action-clear",
        expectedVersion: 1,
        idempotencyKey: "request-clear",
        operation: "clear",
        requestPayloadHash: "sha256:clear",
        value: null,
      }),
    ).toEqual({ result: "accepted", version: 2 });

    expect(await loadActiveOverrides(opened.database)).toEqual([]);
    expect(
      opened.sqlite
        .prepare("select operation, version from configuration_overrides order by version")
        .all(),
    ).toEqual([
      { operation: "set", version: 1 },
      { operation: "clear", version: 2 },
    ]);
  });
});
