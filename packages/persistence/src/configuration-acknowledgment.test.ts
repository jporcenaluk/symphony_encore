import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeConfigurationCandidate,
  loadAcknowledgedCandidateHashes,
} from "./configuration-acknowledgment.js";
import { applyMigrations, type OpenedDatabase, openDatabase } from "./database.js";

let directory: string;
let opened: OpenedDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "symphony-config-ack-"));
  opened = openDatabase(path.join(directory, "symphony.sqlite3"));
  await applyMigrations(opened.database);
});

afterEach(async () => {
  await opened.close();
  await rm(directory, { force: true, recursive: true });
});

const request = {
  actionId: "action-ack-1",
  authSubject: "local:admin",
  candidateHash: "sha256:candidate-1",
  candidateVersion: "workflow:abc123",
  capability: "config.ack",
  createdAt: "2026-07-13T10:00:00Z",
  endpoint: "/api/configuration/acknowledgments",
  expectedCandidateVersion: "workflow:abc123",
  id: "ack-1",
  idempotencyKey: "ack-request-1",
  key: "tracker.kind",
  observedCandidateVersion: "workflow:abc123",
  operatorId: "admin",
  reason: "Approve the configured tracker boundary",
  requestPayloadHash: "sha256:ack-payload-1",
};

describe("configuration candidate acknowledgments", () => {
  it("persists only the exact candidate hash and replays the original result", async () => {
    const first = await acknowledgeConfigurationCandidate(opened.database, request);
    const replay = await acknowledgeConfigurationCandidate(opened.database, {
      ...request,
      actionId: "action-ack-replay",
    });

    expect(first).toEqual({ result: "accepted" });
    expect(replay).toEqual(first);
    expect(await loadAcknowledgedCandidateHashes(opened.database)).toEqual(
      new Set(["sha256:candidate-1"]),
    );
    expect(opened.sqlite.prepare("select count(*) as count from operator_actions").get()).toEqual({
      count: 1,
    });
  });

  it("audits a stale candidate version without acknowledging its hash", async () => {
    expect(
      await acknowledgeConfigurationCandidate(opened.database, {
        ...request,
        observedCandidateVersion: "workflow:newer",
      }),
    ).toEqual({ result: "version_conflict" });
    expect(await loadAcknowledgedCandidateHashes(opened.database)).toEqual(new Set());
    expect(opened.sqlite.prepare("select result from operator_actions").get()).toEqual({
      result: "version_conflict",
    });
  });

  it("audits idempotency conflicts and leaves the original hash unchanged", async () => {
    await acknowledgeConfigurationCandidate(opened.database, request);

    expect(
      await acknowledgeConfigurationCandidate(opened.database, {
        ...request,
        actionId: "action-ack-conflict",
        candidateHash: "sha256:candidate-2",
        requestPayloadHash: "sha256:different",
      }),
    ).toEqual({ result: "idempotency_conflict" });
    expect(await loadAcknowledgedCandidateHashes(opened.database)).toEqual(
      new Set(["sha256:candidate-1"]),
    );
  });
});
