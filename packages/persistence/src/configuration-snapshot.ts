import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface ConfigurationSnapshot {
  acknowledgmentState: Record<string, unknown>;
  adapterVersions: Record<string, unknown>;
  createdAt: string;
  effectiveConfig: Record<string, unknown>;
  id: string;
  operatorOverrideRevision: number;
  promptHash: string;
  restartState: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
  workflowSourceHash: string;
}

interface ConfigurationSnapshotRow {
  acknowledgment_state_json: string;
  adapter_versions_json: string;
  created_at: string;
  effective_config_json: string;
  id: string;
  operator_override_revision: number;
  prompt_hash: string;
  restart_state_json: string;
  source_metadata_json: string;
  workflow_source_hash: string;
}

const SECRET_KEYS = new Set(["bootstrap.admin_credential", "server.session_secret"]);

function validateSecretReferences(config: Readonly<Record<string, unknown>>): void {
  for (const key of SECRET_KEYS) {
    const value = config[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || !/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    ) {
      throw new Error(`Configuration snapshot contains a literal secret at ${key}`);
    }
  }
}

export async function storeConfigurationSnapshot(
  database: Kysely<DatabaseSchema>,
  snapshot: ConfigurationSnapshot,
): Promise<void> {
  validateSecretReferences(snapshot.effectiveConfig);
  await sql`
    insert into config_snapshots (
      id, created_at, workflow_source_hash, operator_override_revision,
      effective_config_json, source_metadata_json, acknowledgment_state_json,
      restart_state_json, prompt_hash, adapter_versions_json
    ) values (
      ${snapshot.id}, ${snapshot.createdAt}, ${snapshot.workflowSourceHash},
      ${snapshot.operatorOverrideRevision}, ${JSON.stringify(snapshot.effectiveConfig)},
      ${JSON.stringify(snapshot.sourceMetadata)}, ${JSON.stringify(snapshot.acknowledgmentState)},
      ${JSON.stringify(snapshot.restartState)}, ${snapshot.promptHash},
      ${JSON.stringify(snapshot.adapterVersions)}
    )
  `.execute(database);
}

export async function loadConfigurationSnapshot(
  database: Kysely<DatabaseSchema>,
  id: string,
): Promise<ConfigurationSnapshot | undefined> {
  const result = await sql<ConfigurationSnapshotRow>`
    select * from config_snapshots where id = ${id}
  `.execute(database);
  const row = result.rows[0];
  if (!row) return undefined;
  return mapConfigurationSnapshot(row);
}

export async function loadLatestConfigurationSnapshot(
  database: Kysely<DatabaseSchema>,
): Promise<ConfigurationSnapshot | undefined> {
  const result = await sql<ConfigurationSnapshotRow>`
    select * from config_snapshots
    order by created_at desc, id desc
    limit 1
  `.execute(database);
  const row = result.rows[0];
  return row ? mapConfigurationSnapshot(row) : undefined;
}

function mapConfigurationSnapshot(row: ConfigurationSnapshotRow): ConfigurationSnapshot {
  return {
    acknowledgmentState: JSON.parse(row.acknowledgment_state_json) as Record<string, unknown>,
    adapterVersions: JSON.parse(row.adapter_versions_json) as Record<string, unknown>,
    createdAt: row.created_at,
    effectiveConfig: JSON.parse(row.effective_config_json) as Record<string, unknown>,
    id: row.id,
    operatorOverrideRevision: row.operator_override_revision,
    promptHash: row.prompt_hash,
    restartState: JSON.parse(row.restart_state_json) as Record<string, unknown>,
    sourceMetadata: JSON.parse(row.source_metadata_json) as Record<string, unknown>,
    workflowSourceHash: row.workflow_source_hash,
  };
}
