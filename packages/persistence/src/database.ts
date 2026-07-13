import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";

interface SchemaMigrationTable {
  applied_at: string;
  checksum: string;
  name: string;
  version: number;
}

export interface DatabaseSchema {
  attempts: Record<string, unknown>;
  budget_ledgers: Record<string, unknown>;
  budget_reservation_ledgers: Record<string, unknown>;
  budget_reservations: Record<string, unknown>;
  claims: Record<string, unknown>;
  config_snapshots: Record<string, unknown>;
  schema_migrations: SchemaMigrationTable;
  service_runs: Record<string, unknown>;
  stage_transitions: Record<string, unknown>;
  terminal_results: Record<string, unknown>;
}

export interface OpenedDatabase {
  close(): Promise<void>;
  database: Kysely<DatabaseSchema>;
  sqlite: SqliteDatabase.Database;
}

export interface RepositoryMigration {
  checksum: string;
  name: string;
  up(database: Kysely<DatabaseSchema>): Promise<void>;
  version: number;
}

const coreControlPlaneMigration: RepositoryMigration = {
  checksum: "sha256:1dcd80c9120b72680f74edbc7fca43cc192d58fd0d12fe5821bbf3e90d82438c",
  name: "core_control_plane",
  async up(database) {
    await sql`
      create table service_runs (
        id text primary key,
        service_version text not null,
        host_id text not null,
        started_at text not null,
        ended_at text,
        status text not null check (status in ('starting', 'recovering', 'ready', 'stopped', 'interrupted', 'failed')),
        startup_config_snapshot_id text,
        start_reason text not null,
        end_reason text
      ) strict
    `.execute(database);
    await sql`
      create table config_snapshots (
        id text primary key,
        created_at text not null,
        workflow_source_hash text not null,
        operator_override_revision integer not null,
        effective_config_json text not null check (json_valid(effective_config_json)),
        source_metadata_json text not null check (json_valid(source_metadata_json)),
        acknowledgment_state_json text not null check (json_valid(acknowledgment_state_json)),
        restart_state_json text not null check (json_valid(restart_state_json)),
        prompt_hash text not null,
        adapter_versions_json text not null check (json_valid(adapter_versions_json))
      ) strict
    `.execute(database);
    await sql`
      create table terminal_results (
        id text primary key,
        attempt_id text not null unique,
        role text not null,
        result_kind text not null,
        payload_json text not null check (json_valid(payload_json)),
        created_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table attempts (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        role text not null check (role in ('plan_review', 'implementation', 'integrative_review', 'specialist_review', 'adjudication', 'synthesis')),
        attempt_number integer not null check (attempt_number > 0),
        workspace_path text not null,
        config_snapshot_id text not null references config_snapshots(id),
        compute_profile text not null check (compute_profile in ('economy', 'standard', 'deep')),
        model text not null,
        reasoning_effort text not null,
        price_table_version text,
        routing_reasons_json text not null check (json_valid(routing_reasons_json)),
        change_class text not null check (change_class in ('trivial', 'standard', 'high_risk')),
        started_at text not null,
        ended_at text,
        status text not null check (status in ('created', 'running', 'awaiting_human', 'closed')),
        terminal_result_id text unique,
        failure_class text,
        input_tokens integer not null default 0 check (input_tokens >= 0),
        output_tokens integer not null default 0 check (output_tokens >= 0),
        total_tokens integer not null default 0 check (total_tokens = input_tokens + output_tokens),
        cost_usd real check (cost_usd is null or cost_usd >= 0),
        unique (work_ref_kind, work_ref_id, attempt_number),
        check (
          (status = 'closed' and ended_at is not null and terminal_result_id is not null)
          or (status != 'closed' and ended_at is null and terminal_result_id is null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table claims (
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        holder text not null,
        mode text not null check (mode in ('Running', 'Ready', 'RetryQueued', 'AwaitingHuman')),
        acquired_at text not null,
        updated_at text not null,
        expires_at text,
        origin_stage text not null,
        reason text not null,
        retry_due_at text,
        blocker_predicate text,
        question_id text,
        approval_request_id text,
        last_comment_cursor text,
        primary key (work_ref_kind, work_ref_id),
        check (
          (mode = 'Running' and expires_at is not null and retry_due_at is null)
          or (mode = 'RetryQueued' and expires_at is null and retry_due_at is not null)
          or (mode in ('Ready', 'AwaitingHuman') and expires_at is null and retry_due_at is null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table budget_ledgers (
        id text primary key,
        scope text not null check (scope in ('attempt', 'issue', 'rolling_24h')),
        scope_id text not null,
        unit text not null check (unit in ('tokens', 'usd')),
        base_limit real not null check (base_limit > 0),
        adjustment real not null default 0,
        effective_limit real not null check (effective_limit > 0),
        reserved real not null default 0 check (reserved >= 0),
        consumed real not null default 0 check (consumed >= 0),
        overrun real not null default 0 check (overrun >= 0),
        version integer not null default 1 check (version > 0),
        updated_at text not null,
        unique (scope, scope_id, unit)
      ) strict
    `.execute(database);
    await sql`
      create table budget_reservations (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text,
        system_job_id text,
        estimated_amounts_json text not null check (json_valid(estimated_amounts_json)),
        actual_amounts_json text not null check (json_valid(actual_amounts_json)),
        status text not null check (status in ('reserved', 'settled', 'released', 'overrun')),
        created_at text not null,
        updated_at text not null,
        check ((attempt_id is not null) != (system_job_id is not null))
      ) strict
    `.execute(database);
    await sql`
      create table budget_reservation_ledgers (
        reservation_id text not null references budget_reservations(id) on delete restrict,
        ledger_id text not null references budget_ledgers(id) on delete restrict,
        reserved_amount real not null check (reserved_amount >= 0),
        primary key (reservation_id, ledger_id)
      ) strict
    `.execute(database);
  },
  version: 1,
};

const stageTransitionMigration: RepositoryMigration = {
  checksum: "sha256:042b7cfa030252f556b11a9bcb7e4ada2456fe9aa7b8fb7391acefb958ce1a03",
  name: "durable_stage_transitions",
  async up(database) {
    await sql`
      create table stage_transitions (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        from_stage text,
        to_stage text not null,
        reason text not null,
        attempt_id text references attempts(id),
        confirmed_external_revision text,
        entered_at text not null,
        exited_at text,
        duration_ms integer check (duration_ms is null or duration_ms >= 0),
        timestamp_source text not null check (timestamp_source in ('receipt', 'tracker', 'observed_estimate')),
        check (from_stage is not null or attempt_id is null),
        check (
          (exited_at is null and duration_ms is null)
          or (exited_at is not null and duration_ms is not null)
        )
      ) strict
    `.execute(database);
    await sql`
      create unique index one_open_stage_per_work_ref
      on stage_transitions (work_ref_kind, work_ref_id)
      where exited_at is null
    `.execute(database);
  },
  version: 2,
};

export const CORE_MIGRATIONS = [
  coreControlPlaneMigration,
  stageTransitionMigration,
] as const satisfies readonly RepositoryMigration[];

export function openDatabase(filename: string): OpenedDatabase {
  const sqlite = new SqliteDatabase(filename);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  const database = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  return {
    async close() {
      await database.destroy();
    },
    database,
    sqlite,
  };
}

async function ensureMigrationTable(database: Kysely<DatabaseSchema>): Promise<void> {
  await database.schema
    .createTable("schema_migrations")
    .ifNotExists()
    .addColumn("version", "integer", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull().unique())
    .addColumn("checksum", "text", (column) => column.notNull())
    .addColumn("applied_at", "text", (column) => column.notNull())
    .execute();
}

export async function applyMigrations(
  database: Kysely<DatabaseSchema>,
  migrations: readonly RepositoryMigration[] = CORE_MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await ensureMigrationTable(database);
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (const migration of ordered) {
    const applied = await database
      .selectFrom("schema_migrations")
      .select(["version", "checksum"])
      .where("version", "=", migration.version)
      .executeTakeFirst();
    if (applied) {
      if (applied.checksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.version} checksum does not match repository migration`,
        );
      }
      continue;
    }

    await database.transaction().execute(async (transaction) => {
      await migration.up(transaction);
      await transaction
        .insertInto("schema_migrations")
        .values({
          applied_at: now(),
          checksum: migration.checksum,
          name: migration.name,
          version: migration.version,
        })
        .executeTakeFirstOrThrow();
    });
  }
}
