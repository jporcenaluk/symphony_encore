import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  CORE_ADAPTER_KINDS,
  CORE_CONFORMANCE_IDS,
  CORE_CONFORMANCE_MANIFEST,
  CORE_CONFORMANCE_MANIFEST_DIGEST,
  CoreConformanceResultSchema,
  type CoreEvidenceBundle,
  CoreEvidenceBundleSchema,
  EXTERNAL_EVIDENCE_IDS,
  ExternalEvidenceSchema,
  NormativeRequirementEvidenceSchema,
  REAL_INTEGRATION_CASE_IDS,
  RealIntegrationEvidenceSchema,
  SelectedAdapterEvidenceSchema,
  validateCoreEvidenceBundle,
} from "./conformance.js";

const EXPECTED_GROUPS = [
  ["Workflow and configuration", "workflow_configuration", "WF", 7],
  ["Durable control plane and recovery", "durable_control_plane_recovery", "DUR", 5],
  ["Plans, attempts, and routing", "plans_attempts_routing", "PLAN", 4],
  ["Budgets, tokens, cost, and time", "budgets_tokens_cost_time", "BUD", 4],
  ["Review, merge, quality, and learning", "review_merge_quality_learning", "REV", 5],
  ["UI, API, and durable history", "ui_api_durable_history", "UI", 7],
  ["Workspace and security", "workspace_security", "SEC", 3],
] as const;

function normalizeRequirementText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

async function parseCoreMatrix(): Promise<
  ReadonlyArray<{ category: string; ordinal: number; requirement_sha256: string }>
> {
  const source = await readFile(new URL("../../../SPEC.md", import.meta.url), "utf8");
  const section = source.split("### 19.2 Core Conformance Test Matrix\n")[1]?.split("### 19.3")[0];
  if (section === undefined) throw new Error("SPEC.md Section 19.2 was not found");

  const groups = [...section.matchAll(/^\*\*(.+?)\*\*\n\n([\s\S]*?)(?=\n\*\*|(?![\s\S]))/gm)];
  expect(groups).toHaveLength(EXPECTED_GROUPS.length);

  return groups.flatMap((group, groupIndex) => {
    const expected = EXPECTED_GROUPS[groupIndex];
    if (expected === undefined) throw new Error(`Unexpected Core matrix group ${groupIndex}`);
    const [, heading = "", body = ""] = group;
    expect(heading).toBe(expected[0]);
    const bullets = [...body.matchAll(/^- (.+(?:\n {2}.+)*)/gm)].map((match) =>
      normalizeRequirementText(match[1] ?? ""),
    );
    expect(bullets).toHaveLength(expected[3]);
    return bullets.map((text, index) => ({
      category: expected[1],
      ordinal: index + 1,
      requirement_sha256: createHash("sha256").update(text).digest("hex"),
    }));
  });
}

function execution(os: "linux" | "macos") {
  return {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    artifact_ref: `artifacts/core/${os}.json`,
    arch: os === "linux" ? "x64" : "arm64",
    ci_provider: "github_actions",
    command: "corepack pnpm test:core",
    exit_code: 0,
    kind: "core_execution" as const,
    node_version: "24.4.1",
    observed_tests: ["rejects an unauthorized mutation"],
    platform: os,
    producer_version: "1.2.3",
    status: "passed" as const,
    test_selectors: ["core/authorization.test.ts"],
  };
}

function validBundle(): CoreEvidenceBundle {
  return {
    kind: "core_evidence_bundle",
    manifest_digest: CORE_CONFORMANCE_MANIFEST_DIGEST,
    producer_version: "1.2.3",
    results: CORE_CONFORMANCE_MANIFEST.map((entry) => ({
      executions: [execution("linux"), execution("macos")],
      id: entry.id,
      requirement_sha256: entry.requirement_sha256,
      revision: "0123456789abcdef0123456789abcdef01234567",
      status: "passed" as const,
    })),
    revision: "0123456789abcdef0123456789abcdef01234567",
    schema_version: "1",
    selected_adapters: ["tracker", "repository_host", "agent", "authentication"].map(
      (adapterKind) => ({
        adapter_kind: adapterKind as "tracker" | "repository_host" | "agent" | "authentication",
        adapter_version: "1.2.3",
        artifact_digest: `sha256:${"b".repeat(64)}`,
        artifact_ref: `artifacts/adapters/${adapterKind}.json`,
        implementation: `selected-${adapterKind}`,
        kind: "selected_adapter" as const,
        revision: "0123456789abcdef0123456789abcdef01234567",
        status: "passed" as const,
      }),
    ),
    source_date_epoch: 1_784_000_000,
  };
}

function cloneBundle(): CoreEvidenceBundle {
  return structuredClone(validBundle());
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected a first fixture value");
  return value;
}

function second<T>(values: readonly T[]): T {
  const value = values[1];
  if (value === undefined) throw new Error("Expected a second fixture value");
  return value;
}

function firstExecution(bundle: CoreEvidenceBundle) {
  return first(first(bundle.results).executions);
}

describe("Core Conformance manifest", () => {
  it("requires exactly the four selected Core adapter kinds from Section 19.1", () => {
    expect(CORE_ADAPTER_KINDS).toEqual(["tracker", "repository_host", "agent", "authentication"]);
  });

  it("binds exactly the 35 Section 19.2 bullets in source order", async () => {
    const parsed = await parseCoreMatrix();
    const expectedIds = EXPECTED_GROUPS.flatMap(([, , prefix, count]) =>
      Array.from(
        { length: count },
        (_, index) => `C-${prefix}-${String(index + 1).padStart(2, "0")}`,
      ),
    );

    expect(CORE_CONFORMANCE_IDS).toHaveLength(35);
    expect(new Set(CORE_CONFORMANCE_IDS).size).toBe(35);
    expect(CORE_CONFORMANCE_IDS).toEqual(expectedIds);
    expect(CORE_CONFORMANCE_MANIFEST).toHaveLength(35);
    expect(
      CORE_CONFORMANCE_MANIFEST.map(({ category, id, ordinal, requirement_sha256 }) => ({
        category,
        id,
        ordinal,
        requirement_sha256,
      })),
    ).toEqual(
      parsed.map((entry, index) => ({
        ...entry,
        id: CORE_CONFORMANCE_IDS[index],
      })),
    );
  });

  it("binds the reviewed manifest to a stable digest", () => {
    expect(
      createHash("sha256").update(JSON.stringify(CORE_CONFORMANCE_MANIFEST)).digest("hex"),
    ).toBe(CORE_CONFORMANCE_MANIFEST_DIGEST);
  });
});

describe("Core evidence", () => {
  it("accepts one passing in-order result per manifest ID with required evidence", () => {
    const bundle = validBundle();
    delete firstExecution(bundle).artifact_ref;
    expect(Value.Check(CoreEvidenceBundleSchema, bundle)).toBe(true);
    expect(validateCoreEvidenceBundle(bundle)).toEqual({ ok: true });
  });

  it.each([
    ["missing", (bundle: CoreEvidenceBundle) => bundle.results.pop()],
    [
      "duplicate",
      (bundle: CoreEvidenceBundle) => {
        bundle.results[1] = structuredClone(first(bundle.results));
      },
    ],
    [
      "out-of-order",
      (bundle: CoreEvidenceBundle) => {
        [bundle.results[0], bundle.results[1]] = [second(bundle.results), first(bundle.results)];
      },
    ],
    [
      "manifest hash drift",
      (bundle: CoreEvidenceBundle) => {
        first(bundle.results).requirement_sha256 = "f".repeat(64);
      },
    ],
    [
      "revision drift",
      (bundle: CoreEvidenceBundle) => {
        first(bundle.results).revision = "abcdef0123456789abcdef0123456789abcdef01";
      },
    ],
    [
      "producer drift",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).producer_version = "9.9.9";
      },
    ],
    [
      "empty selectors",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).test_selectors = [];
      },
    ],
    [
      "empty observed tests",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).observed_tests = [];
      },
    ],
    [
      "failed status",
      (bundle: CoreEvidenceBundle) => {
        first(bundle.results).status = "failed";
      },
    ],
    [
      "skipped execution",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).status = "skipped";
      },
    ],
    [
      "partial execution",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).status = "partial";
      },
    ],
    [
      "exit-code mismatch",
      (bundle: CoreEvidenceBundle) => {
        firstExecution(bundle).exit_code = 1;
      },
    ],
    [
      "required platform missing",
      (bundle: CoreEvidenceBundle) => {
        first(bundle.results).executions = [execution("linux")];
      },
    ],
    [
      "required adapter missing",
      (bundle: CoreEvidenceBundle) => {
        bundle.selected_adapters = bundle.selected_adapters.filter(
          (adapter) => adapter.adapter_kind !== "agent",
        );
      },
    ],
    [
      "duplicate selected adapter",
      (bundle: CoreEvidenceBundle) => {
        bundle.selected_adapters.push(structuredClone(first(bundle.selected_adapters)));
      },
    ],
    [
      "duplicate execution platform",
      (bundle: CoreEvidenceBundle) => {
        first(bundle.results).executions.push(execution("linux"));
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const bundle = cloneBundle();
    mutate(bundle);
    expect(validateCoreEvidenceBundle(bundle).ok).toBe(false);
  });

  it("rejects unknown IDs and additional properties at the schema boundary", () => {
    const unknown = cloneBundle() as unknown as { results: Array<{ id: string }> };
    first(unknown.results).id = "C-UNKNOWN-01";
    expect(validateCoreEvidenceBundle(unknown).ok).toBe(false);

    const additional = cloneBundle() as CoreEvidenceBundle & { extra?: boolean };
    additional.extra = true;
    expect(Value.Check(CoreEvidenceBundleSchema, additional)).toBe(false);
    expect(validateCoreEvidenceBundle(additional).ok).toBe(false);
  });
});

describe("non-substitutable conformance evidence", () => {
  it("keeps generic Sections 1-18 evidence separate from Core matrix results", () => {
    const normative = {
      artifact_digest: `sha256:${"e".repeat(64)}`,
      document: "SPEC",
      kind: "normative_requirement",
      requirement_id: "SPEC-3.14-MUST-01",
      requirement_sha256: "f".repeat(64),
      revision: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
    };

    expect(Value.Check(NormativeRequirementEvidenceSchema, normative)).toBe(true);
    expect(Value.Check(CoreConformanceResultSchema, normative)).toBe(false);
    expect(
      Value.Check(CoreEvidenceBundleSchema, {
        ...validBundle(),
        results: [normative],
      }),
    ).toBe(false);
  });

  it("uses fixed Real Integration and external evidence identifiers", () => {
    expect(REAL_INTEGRATION_CASE_IDS).toEqual([
      "smoke_lifecycle",
      "human_question",
      "stale_ui_mutation",
      "privileged_acknowledgment",
      "budget_denial",
      "idempotent_mutation_replay",
      "repair_pr",
    ]);
    expect(EXTERNAL_EVIDENCE_IDS).toEqual([
      "ci.linux",
      "ci.macos",
      "platform.wsl",
      "container.build",
      "container.non_root_read_only",
      "container.lifecycle_persistence",
      "security.codeql",
      "security.dependency_review",
      "security.gitleaks",
      "security.trivy",
      "security.workflow",
      "repository.branch_protection",
      "repository.squash_policy",
      "repository.required_checks",
      "repository.merge_queue",
      "artifact.image",
      "artifact.sbom",
      "artifact.provenance",
      "release.promotion_without_rebuild",
      "release.rollback",
    ]);
    expect(new Set(EXTERNAL_EVIDENCE_IDS).size).toBe(20);
  });

  it("discriminates selected adapter, Real Integration, and external evidence", () => {
    const selected = first(validBundle().selected_adapters);
    const real = {
      artifact_digest: `sha256:${"c".repeat(64)}`,
      artifact_ref: "artifacts/real/smoke.json",
      case_id: "smoke_lifecycle",
      kind: "real_integration",
      revision: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
    };
    const external = {
      artifact_digest: `sha256:${"d".repeat(64)}`,
      artifact_ref: "artifacts/external/ci-linux.json",
      environment: "github-actions",
      evidence_id: "ci.linux",
      expires_at: "2026-07-14T12:00:00.000Z",
      kind: "external",
      observed_at: "2026-07-13T12:00:00.000Z",
      observed_state: "success",
      repository: "jporcenaluk/wheelsparrow",
      revision: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
      target: "refs/pull/3/head",
    };

    expect(Value.Check(SelectedAdapterEvidenceSchema, selected)).toBe(true);
    expect(Value.Check(RealIntegrationEvidenceSchema, real)).toBe(true);
    expect(Value.Check(ExternalEvidenceSchema, external)).toBe(true);
    expect(Value.Check(SelectedAdapterEvidenceSchema, real)).toBe(false);
    expect(Value.Check(RealIntegrationEvidenceSchema, external)).toBe(false);
    expect(Value.Check(ExternalEvidenceSchema, selected)).toBe(false);
  });
});
