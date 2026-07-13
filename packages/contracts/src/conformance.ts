import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ArtifactDigest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const Revision = Type.String({ pattern: "^[a-f0-9]{40}$" });

export const CORE_CONFORMANCE_IDS = [
  "C-WF-01",
  "C-WF-02",
  "C-WF-03",
  "C-WF-04",
  "C-WF-05",
  "C-WF-06",
  "C-WF-07",
  "C-DUR-01",
  "C-DUR-02",
  "C-DUR-03",
  "C-DUR-04",
  "C-DUR-05",
  "C-PLAN-01",
  "C-PLAN-02",
  "C-PLAN-03",
  "C-PLAN-04",
  "C-BUD-01",
  "C-BUD-02",
  "C-BUD-03",
  "C-BUD-04",
  "C-REV-01",
  "C-REV-02",
  "C-REV-03",
  "C-REV-04",
  "C-REV-05",
  "C-UI-01",
  "C-UI-02",
  "C-UI-03",
  "C-UI-04",
  "C-UI-05",
  "C-UI-06",
  "C-UI-07",
  "C-SEC-01",
  "C-SEC-02",
  "C-SEC-03",
] as const;
export const CORE_CONFORMANCE_ID_COUNT: 35 = CORE_CONFORMANCE_IDS.length;

export const CoreConformanceIdSchema = Type.Union(
  CORE_CONFORMANCE_IDS.map((id) => Type.Literal(id)),
);
export type CoreConformanceId = Static<typeof CoreConformanceIdSchema>;

export const CORE_CONFORMANCE_CATEGORIES = [
  "workflow_configuration",
  "durable_control_plane_recovery",
  "plans_attempts_routing",
  "budgets_tokens_cost_time",
  "review_merge_quality_learning",
  "ui_api_durable_history",
  "workspace_security",
] as const;
export const CoreConformanceCategorySchema = Type.Union(
  CORE_CONFORMANCE_CATEGORIES.map((category) => Type.Literal(category)),
);
export type CoreConformanceCategory = Static<typeof CoreConformanceCategorySchema>;

export const CORE_ADAPTER_KINDS = [
  "tracker",
  "repository_host",
  "agent",
  "authentication",
] as const;
export const CoreAdapterKindSchema = Type.Union(
  CORE_ADAPTER_KINDS.map((adapterKind) => Type.Literal(adapterKind)),
);
export type CoreAdapterKind = Static<typeof CoreAdapterKindSchema>;

export const CORE_PLATFORMS = ["linux", "macos"] as const;
export const CorePlatformSchema = Type.Union(
  CORE_PLATFORMS.map((platform) => Type.Literal(platform)),
);
export type CorePlatform = Static<typeof CorePlatformSchema>;

export interface CoreConformanceManifestEntry {
  readonly category: CoreConformanceCategory;
  readonly id: CoreConformanceId;
  readonly ordinal: number;
  readonly required_adapter_kinds: readonly CoreAdapterKind[];
  readonly required_platforms: readonly CorePlatform[];
  readonly requirement_sha256: string;
}

const REQUIRED_PLATFORMS = ["linux", "macos"] as const;

function manifestEntry(
  idIndex: number,
  category: CoreConformanceCategory,
  ordinal: number,
  requirementSha256: string,
  requiredAdapterKinds: readonly CoreAdapterKind[],
): CoreConformanceManifestEntry {
  const id = CORE_CONFORMANCE_IDS[idIndex];
  if (id === undefined) throw new Error(`Invalid Core Conformance ID index ${idIndex}`);
  return {
    category,
    id,
    ordinal,
    required_adapter_kinds: requiredAdapterKinds,
    required_platforms: REQUIRED_PLATFORMS,
    requirement_sha256: requirementSha256,
  };
}

export const CORE_CONFORMANCE_MANIFEST = [
  manifestEntry(
    0,
    "workflow_configuration",
    1,
    "52c6759ece87cfb8dea459d8339df728fbe9c36599d7bdd1a44561ac6e2b96e0",
    [],
  ),
  manifestEntry(
    1,
    "workflow_configuration",
    2,
    "870e8dbca5cb8d68480406f6f528d6e772668e39c7710dc91278dbaca94382bd",
    [],
  ),
  manifestEntry(
    2,
    "workflow_configuration",
    3,
    "1ccaec958c12277922c5e650602b1b5216ae67dde52b76fe9f98df54a7117b43",
    ["authentication"],
  ),
  manifestEntry(
    3,
    "workflow_configuration",
    4,
    "180ee7bac4ffe1474c4376dff9e202b89a36127445e945b6bec9755a9657a1be",
    [],
  ),
  manifestEntry(
    4,
    "workflow_configuration",
    5,
    "21db0d8c03e60125262930b73a83b1fce39b95c98e4bc682e3c5a6f318a426cc",
    ["authentication"],
  ),
  manifestEntry(
    5,
    "workflow_configuration",
    6,
    "53e8fcb03877f07c3593602549eb72acf7738ed6b5df7967eb63b99bcfffffcc",
    ["authentication", "tracker", "repository_host", "agent"],
  ),
  manifestEntry(
    6,
    "workflow_configuration",
    7,
    "5afd14aa223fcf344d29676e21fe3bcf5d86ec86fc3a2b9bdf8d555a4928e5c5",
    ["agent"],
  ),
  manifestEntry(
    7,
    "durable_control_plane_recovery",
    1,
    "37662a1be32eaf76581ef0812556e34d2150071dee2781db56dbcd52d51d01b2",
    ["tracker"],
  ),
  manifestEntry(
    8,
    "durable_control_plane_recovery",
    2,
    "b00d5bfef14980e4f930cec0af510450d1c7108c689c53d85b3498ea68b08c7c",
    [],
  ),
  manifestEntry(
    9,
    "durable_control_plane_recovery",
    3,
    "0b226c183fea94cb4b43ba711232edb7bfae1c3adf62db59d1027d690e21b5c3",
    ["agent"],
  ),
  manifestEntry(
    10,
    "durable_control_plane_recovery",
    4,
    "e6cf755a1f59947ad07369b7f60fd429fa6ab3e11984b26ba633bda7e729f13d",
    ["tracker", "repository_host"],
  ),
  manifestEntry(
    11,
    "durable_control_plane_recovery",
    5,
    "2edd4ed771e6b26f02c78ef219e1ec8578814842f6f39096a7f7dd07c3fdb0b7",
    ["agent"],
  ),
  manifestEntry(
    12,
    "plans_attempts_routing",
    1,
    "68720d41cd5c52b189753ccd88eacafb3eecd6f5e87df7ab29cbe6439d86c6c4",
    ["agent"],
  ),
  manifestEntry(
    13,
    "plans_attempts_routing",
    2,
    "98cb89b52263fb4828f6dc159b98f9a64c982fe0afd9fa51ac1ed87b1b9ddebb",
    ["agent"],
  ),
  manifestEntry(
    14,
    "plans_attempts_routing",
    3,
    "9eecce8cce14220ff6538898be7ef523de1ddd29efa2b17eb4c2d6fb131b9ebd",
    ["agent"],
  ),
  manifestEntry(
    15,
    "plans_attempts_routing",
    4,
    "61d143b045833ddbd0bd844e8ca83f2f9363638f17f72d50397ee2eb4383b559",
    ["agent"],
  ),
  manifestEntry(
    16,
    "budgets_tokens_cost_time",
    1,
    "35b935ac529c4839495d8b34d3c0299bb43dea6347c0c6a9c0285321da26f0f6",
    ["agent"],
  ),
  manifestEntry(
    17,
    "budgets_tokens_cost_time",
    2,
    "71422e2bea801722bb2a62ffa94ffed84547afdee5bba516669607163fadf218",
    ["agent"],
  ),
  manifestEntry(
    18,
    "budgets_tokens_cost_time",
    3,
    "45d506af812004917ccef7f3a2d10c6d6b1c8f854a7181ea6c76f77e8a4e976f",
    ["agent", "authentication"],
  ),
  manifestEntry(
    19,
    "budgets_tokens_cost_time",
    4,
    "de1027ea876406062a9805b2db2f3023e8934f94b59927c4516ad39eee25013d",
    [],
  ),
  manifestEntry(
    20,
    "review_merge_quality_learning",
    1,
    "fc6c1e425efeed71e75dd112bed8c4cb017fde0da8f76d468ebace194b9c46d4",
    ["repository_host", "authentication"],
  ),
  manifestEntry(
    21,
    "review_merge_quality_learning",
    2,
    "721aebb7442d703889a3235eca4f18729f9e928a60e73ab2beafc6080ee0658d",
    ["repository_host", "agent"],
  ),
  manifestEntry(
    22,
    "review_merge_quality_learning",
    3,
    "717c47ed0901381532c787698cde115685239244cdb5d485c769f3ef086673f2",
    ["repository_host"],
  ),
  manifestEntry(
    23,
    "review_merge_quality_learning",
    4,
    "18a7dadc38335426135139ff71d2212b1b96f9a594cf8666d1b462995c28c9a2",
    ["repository_host"],
  ),
  manifestEntry(
    24,
    "review_merge_quality_learning",
    5,
    "9db2f8d00d8bacb1775b14398d38ab65dfdfe0ab5d6ace1be3e5a23e3f469b46",
    ["agent"],
  ),
  manifestEntry(
    25,
    "ui_api_durable_history",
    1,
    "7c0390085c1ad8e2bc25065e9371fe9a617849fbc08a8d3a648f98cc2c161a29",
    [],
  ),
  manifestEntry(
    26,
    "ui_api_durable_history",
    2,
    "7110368aa13a662239973c96fc23b75ba73da99768574173f6c7fd3ca1d39d7c",
    ["tracker", "repository_host"],
  ),
  manifestEntry(
    27,
    "ui_api_durable_history",
    3,
    "ea3b0d2a762edb3ca09b407329ea703aa5f7c1fd909e4adb8b8cb2fd7dd66477",
    ["agent"],
  ),
  manifestEntry(
    28,
    "ui_api_durable_history",
    4,
    "e3eaae8d6c8708e7802b4d17c1336625779b0bbf3ea4d55d4025e55877103682",
    ["authentication"],
  ),
  manifestEntry(
    29,
    "ui_api_durable_history",
    5,
    "41876dcd1333cd14135f24b97835127df13d2c3ac512835f80cf5334a2b3c070",
    ["authentication", "agent"],
  ),
  manifestEntry(
    30,
    "ui_api_durable_history",
    6,
    "db2b4f3f799f3ba7f19a3b7b49122fe75ad70212c2f95c0cf37ff7c0102c4d2d",
    [],
  ),
  manifestEntry(
    31,
    "ui_api_durable_history",
    7,
    "c51136a34603cc663f640d05edcf59c14877ead3a683c1dde3d2ac5e04e3d811",
    ["authentication"],
  ),
  manifestEntry(
    32,
    "workspace_security",
    1,
    "63029bc306dfb5ed2fd41d0ba9056a148ce49ee0f36b98f37260b8a9a2a4110e",
    ["agent"],
  ),
  manifestEntry(
    33,
    "workspace_security",
    2,
    "b8c3d61c3c9f8faa5e377f7db7226c258d2879911604b3ccfbbb3eea583d71db",
    ["agent"],
  ),
  manifestEntry(
    34,
    "workspace_security",
    3,
    "e93e76d9ea7816cb68f00a54c8dba05e34ba99540596de92b99142216fdc9630",
    ["tracker", "repository_host", "authentication"],
  ),
] as const satisfies readonly CoreConformanceManifestEntry[];

export const CORE_CONFORMANCE_MANIFEST_DIGEST =
  "1b8f7eb2fdfe6dc2f810e4cb32d3a9fed53f5525e31f4e0d160388f49af51544" as const;

const EvidenceStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("partial"),
]);

export const CoreConformanceExecutionSchema = Type.Object(
  {
    artifact_digest: ArtifactDigest,
    artifact_ref: Type.Optional(NonEmptyString),
    arch: NonEmptyString,
    ci_provider: NonEmptyString,
    command: NonEmptyString,
    exit_code: Type.Integer(),
    kind: Type.Literal("core_execution"),
    node_version: NonEmptyString,
    observed_tests: Type.Array(NonEmptyString, { minItems: 1 }),
    platform: CorePlatformSchema,
    producer_version: NonEmptyString,
    status: EvidenceStatusSchema,
    test_selectors: Type.Array(NonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type CoreConformanceExecution = Static<typeof CoreConformanceExecutionSchema>;

export const CoreConformanceResultSchema = Type.Object(
  {
    executions: Type.Array(CoreConformanceExecutionSchema, { minItems: 1 }),
    id: CoreConformanceIdSchema,
    requirement_sha256: Sha256,
    revision: Revision,
    status: EvidenceStatusSchema,
  },
  { additionalProperties: false },
);
export type CoreConformanceResult = Static<typeof CoreConformanceResultSchema>;

export const NORMATIVE_DOCUMENTS = ["SPEC", "TECH_STACK", "CICD"] as const;
export const NormativeDocumentSchema = Type.Union(
  NORMATIVE_DOCUMENTS.map((document) => Type.Literal(document)),
);
export type NormativeDocument = Static<typeof NormativeDocumentSchema>;

export const NormativeRequirementEvidenceSchema = Type.Object(
  {
    artifact_digest: ArtifactDigest,
    artifact_ref: Type.Optional(NonEmptyString),
    document: NormativeDocumentSchema,
    kind: Type.Literal("normative_requirement"),
    requirement_id: NonEmptyString,
    requirement_sha256: Sha256,
    revision: Revision,
    status: EvidenceStatusSchema,
  },
  { additionalProperties: false },
);
export type NormativeRequirementEvidence = Static<typeof NormativeRequirementEvidenceSchema>;

export const SelectedAdapterEvidenceSchema = Type.Object(
  {
    adapter_kind: CoreAdapterKindSchema,
    adapter_version: NonEmptyString,
    artifact_digest: ArtifactDigest,
    artifact_ref: NonEmptyString,
    implementation: NonEmptyString,
    kind: Type.Literal("selected_adapter"),
    revision: Revision,
    status: EvidenceStatusSchema,
  },
  { additionalProperties: false },
);
export type SelectedAdapterEvidence = Static<typeof SelectedAdapterEvidenceSchema>;

export const REAL_INTEGRATION_CASE_IDS = [
  "smoke_lifecycle",
  "human_question",
  "stale_ui_mutation",
  "privileged_acknowledgment",
  "budget_denial",
  "idempotent_mutation_replay",
  "repair_pr",
] as const;
export const RealIntegrationCaseIdSchema = Type.Union(
  REAL_INTEGRATION_CASE_IDS.map((caseId) => Type.Literal(caseId)),
);
export type RealIntegrationCaseId = Static<typeof RealIntegrationCaseIdSchema>;

export const RealIntegrationEvidenceSchema = Type.Object(
  {
    artifact_digest: ArtifactDigest,
    artifact_ref: NonEmptyString,
    case_id: RealIntegrationCaseIdSchema,
    kind: Type.Literal("real_integration"),
    revision: Revision,
    status: EvidenceStatusSchema,
  },
  { additionalProperties: false },
);
export type RealIntegrationEvidence = Static<typeof RealIntegrationEvidenceSchema>;

export const EXTERNAL_EVIDENCE_IDS = [
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
] as const;
export const ExternalEvidenceIdSchema = Type.Union(
  EXTERNAL_EVIDENCE_IDS.map((evidenceId) => Type.Literal(evidenceId)),
);
export type ExternalEvidenceId = Static<typeof ExternalEvidenceIdSchema>;

export const ExternalEvidenceSchema = Type.Object(
  {
    artifact_digest: ArtifactDigest,
    artifact_ref: NonEmptyString,
    environment: NonEmptyString,
    evidence_id: ExternalEvidenceIdSchema,
    expires_at: Type.Union([NonEmptyString, Type.Null()]),
    kind: Type.Literal("external"),
    observed_at: NonEmptyString,
    observed_state: NonEmptyString,
    repository: NonEmptyString,
    revision: Revision,
    status: EvidenceStatusSchema,
    target: NonEmptyString,
  },
  { additionalProperties: false },
);
export type ExternalEvidence = Static<typeof ExternalEvidenceSchema>;

export const CoreEvidenceBundleSchema = Type.Object(
  {
    kind: Type.Literal("core_evidence_bundle"),
    manifest_digest: Sha256,
    producer_version: NonEmptyString,
    results: Type.Array(CoreConformanceResultSchema, { minItems: 1 }),
    revision: Revision,
    schema_version: Type.Literal("1"),
    selected_adapters: Type.Array(SelectedAdapterEvidenceSchema),
    source_date_epoch: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CoreEvidenceBundle = Static<typeof CoreEvidenceBundleSchema>;

export type CoreEvidenceValidation =
  | { readonly ok: true }
  | { readonly errors: readonly string[]; readonly ok: false };

export function validateCoreEvidenceBundle(value: unknown): CoreEvidenceValidation {
  if (!Value.Check(CoreEvidenceBundleSchema, value)) {
    return { errors: ["core_evidence.schema_invalid"], ok: false };
  }

  const errors: string[] = [];
  if (value.manifest_digest !== CORE_CONFORMANCE_MANIFEST_DIGEST) {
    errors.push("core_evidence.manifest_drift");
  }
  if (value.results.length !== CORE_CONFORMANCE_MANIFEST.length) {
    errors.push("core_evidence.result_count");
  }

  for (const [index, manifest] of CORE_CONFORMANCE_MANIFEST.entries()) {
    const result = value.results[index];
    if (result === undefined) continue;
    if (result.id !== manifest.id) errors.push(`core_evidence.result_order:${manifest.id}`);
    if (result.requirement_sha256 !== manifest.requirement_sha256) {
      errors.push(`core_evidence.requirement_hash:${manifest.id}`);
    }
    if (result.revision !== value.revision) {
      errors.push(`core_evidence.result_revision:${manifest.id}`);
    }
    if (result.status !== "passed") errors.push(`core_evidence.result_status:${manifest.id}`);

    const observedPlatforms = new Set<CorePlatform>();
    for (const execution of result.executions) {
      if (observedPlatforms.has(execution.platform)) {
        errors.push(`core_evidence.duplicate_platform:${manifest.id}:${execution.platform}`);
      }
      observedPlatforms.add(execution.platform);
      if (execution.producer_version !== value.producer_version) {
        errors.push(`core_evidence.producer_drift:${manifest.id}`);
      }
      if (execution.status !== "passed") {
        errors.push(`core_evidence.execution_status:${manifest.id}:${execution.platform}`);
      }
      if (execution.exit_code !== 0) {
        errors.push(`core_evidence.exit_code:${manifest.id}:${execution.platform}`);
      }
    }
    for (const platform of manifest.required_platforms) {
      if (!observedPlatforms.has(platform)) {
        errors.push(`core_evidence.required_platform:${manifest.id}:${platform}`);
      }
    }

    for (const adapterKind of manifest.required_adapter_kinds) {
      const evidence = value.selected_adapters.find(
        (candidate) => candidate.adapter_kind === adapterKind,
      );
      if (
        evidence === undefined ||
        evidence.status !== "passed" ||
        evidence.revision !== value.revision
      ) {
        errors.push(`core_evidence.required_adapter:${manifest.id}:${adapterKind}`);
      }
    }
  }

  const resultIds = new Set(value.results.map((result) => result.id));
  if (resultIds.size !== value.results.length) errors.push("core_evidence.duplicate_result");

  const adapterKinds = new Set(value.selected_adapters.map((adapter) => adapter.adapter_kind));
  if (adapterKinds.size !== value.selected_adapters.length) {
    errors.push("core_evidence.duplicate_adapter");
  }

  for (const adapter of value.selected_adapters) {
    if (adapter.status !== "passed") {
      errors.push(`core_evidence.adapter_status:${adapter.adapter_kind}`);
    }
    if (adapter.revision !== value.revision) {
      errors.push(`core_evidence.adapter_revision:${adapter.adapter_kind}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { errors, ok: false };
}
