import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";

interface SchemaMigrationTable {
  applied_at: string;
  checksum: string;
  name: string;
  version: number;
}

export interface DatabaseSchema {
  agent_approval_requests: Record<string, unknown>;
  attempts: Record<string, unknown>;
  budget_adjustments: Record<string, unknown>;
  budget_ledgers: Record<string, unknown>;
  budget_reservation_ledgers: Record<string, unknown>;
  budget_reservations: Record<string, unknown>;
  bootstrap_state: Record<string, unknown>;
  claims: Record<string, unknown>;
  config_snapshots: Record<string, unknown>;
  configuration_acknowledgments: Record<string, unknown>;
  configuration_overrides: Record<string, unknown>;
  evidence_blobs: Record<string, unknown>;
  event_records: Record<string, unknown>;
  guard_decisions: Record<string, unknown>;
  issues: Record<string, unknown>;
  lessons: Record<string, unknown>;
  live_sessions: Record<string, unknown>;
  local_operator_credentials: Record<string, unknown>;
  log_records: Record<string, unknown>;
  mutation_authorizations: Record<string, unknown>;
  operator_actions: Record<string, unknown>;
  operator_idempotency_keys: Record<string, unknown>;
  operator_questions: Record<string, unknown>;
  operator_sessions: Record<string, unknown>;
  operators: Record<string, unknown>;
  parked_work: Record<string, unknown>;
  plans: Record<string, unknown>;
  repository_links: Record<string, unknown>;
  retry_entries: Record<string, unknown>;
  review_records: Record<string, unknown>;
  review_sets: Record<string, unknown>;
  rules: Record<string, unknown>;
  schema_migrations: SchemaMigrationTable;
  service_runs: Record<string, unknown>;
  side_effect_intents: Record<string, unknown>;
  side_effect_receipts: Record<string, unknown>;
  stage_transitions: Record<string, unknown>;
  startup_failures: Record<string, unknown>;
  system_jobs: Record<string, unknown>;
  terminal_results: Record<string, unknown>;
  usage_samples: Record<string, unknown>;
  verification_records: Record<string, unknown>;
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

const configurationOverrideMigration: RepositoryMigration = {
  checksum: "sha256:2835087d9d6f184f1cb6587038f620b493707fc9f04647ab83c149d975552968",
  name: "configuration_overrides_and_operator_audit",
  async up(database) {
    await sql`
      create table operator_actions (
        id text primary key,
        operator_id text not null,
        auth_subject text not null,
        capability text not null,
        endpoint text not null,
        action text not null,
        target text not null,
        reason text not null,
        expected_version integer not null check (expected_version >= 0),
        observed_version integer not null check (observed_version >= 0),
        idempotency_key text not null,
        request_payload_hash text not null,
        result text not null,
        created_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table operator_idempotency_keys (
        operator_id text not null,
        endpoint text not null,
        target text not null,
        idempotency_key text not null,
        request_payload_hash text not null,
        original_action_id text not null references operator_actions(id),
        response_json text not null check (json_valid(response_json)),
        primary key (operator_id, endpoint, target, idempotency_key)
      ) strict
    `.execute(database);
    await sql`
      create table configuration_overrides (
        key text not null,
        version integer not null check (version > 0),
        operation text not null check (operation in ('set', 'clear')),
        value_json text check (value_json is null or json_valid(value_json)),
        created_by text not null,
        created_at text not null,
        reason text not null,
        validation_result text not null,
        acknowledgment_state text not null,
        reload_state text not null,
        operator_action_id text not null unique references operator_actions(id),
        primary key (key, version),
        check (
          (operation = 'set' and value_json is not null)
          or (operation = 'clear' and value_json is null)
        )
      ) strict
    `.execute(database);
  },
  version: 3,
};

const configurationAcknowledgmentMigration: RepositoryMigration = {
  checksum: "sha256:9fbc8cf62392b0dc9c52f12802deaa9d1df76ad9f45613e76327985a09b7f7f8",
  name: "exact_configuration_acknowledgments",
  async up(database) {
    await sql`alter table operator_actions add column expected_version_ref text`.execute(database);
    await sql`alter table operator_actions add column observed_version_ref text`.execute(database);
    await sql`
      create table configuration_acknowledgments (
        id text primary key,
        key text not null,
        candidate_hash text not null unique,
        candidate_version text not null,
        acknowledged_by text not null,
        acknowledged_at text not null,
        operator_action_id text not null unique references operator_actions(id)
      ) strict
    `.execute(database);
  },
  version: 4,
};

const durableDomainRecordsMigration: RepositoryMigration = {
  checksum: "sha256:61e92320ad7c29cc61b72b6f9f9a8dcd7c9f257e9e612a5bc67d415ad553a23e",
  name: "durable_domain_records",
  async up(database) {
    await sql`
      create table issues (
        id text primary key,
        identifier text not null unique,
        title text not null,
        description text not null,
        acceptance_criteria_json text not null check (json_valid(acceptance_criteria_json)),
        state text not null check (state in ('Backlog', 'Todo', 'In Progress', 'Review', 'Human', 'Done')),
        labels_json text not null check (json_valid(labels_json)),
        priority integer,
        blocked_by_json text not null check (json_valid(blocked_by_json)),
        assignee_id text,
        repo_owner text not null,
        repo_name text not null,
        url text not null,
        provider_revision text not null,
        created_at text not null,
        updated_at text not null
      ) strict
    `.execute(database);
    await sql`
      create index issues_dispatch_order on issues (state, priority, created_at, identifier)
    `.execute(database);
    await sql`
      create table system_jobs (
        id text primary key,
        kind text not null check (kind in ('synthesis', 'repair')),
        parent_work_ref_kind text check (parent_work_ref_kind in ('issue', 'system_job')),
        parent_work_ref_id text,
        repository text not null,
        workspace_path text not null,
        goal text not null,
        acceptance_criteria_json text not null check (json_valid(acceptance_criteria_json)),
        config_snapshot_id text not null references config_snapshots(id),
        status text not null check (status in ('queued', 'running', 'review', 'merge', 'rework', 'human', 'budget_exhausted', 'failed', 'done')),
        input_tokens integer not null default 0 check (input_tokens >= 0),
        output_tokens integer not null default 0 check (output_tokens >= 0),
        cost_usd real check (cost_usd is null or cost_usd >= 0),
        created_at text not null,
        started_at text,
        ended_at text,
        final_result_id text,
        check (
          (kind = 'repair' and parent_work_ref_kind is not null and parent_work_ref_id is not null)
          or (kind = 'synthesis' and parent_work_ref_kind is null and parent_work_ref_id is null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table verification_records (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text not null references attempts(id),
        config_snapshot_id text not null references config_snapshots(id),
        target_revision text not null,
        command_hash text not null,
        started_at text not null,
        ended_at text not null,
        exit_code integer not null,
        result text not null check (result in ('passed', 'failed', 'error')),
        stdout_ref text,
        stderr_ref text,
        environment_policy_hash text not null
      ) strict
    `.execute(database);
    await sql`
      create table review_records (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text not null unique references attempts(id),
        reviewer_role text not null check (reviewer_role in ('integrative_review', 'specialist_review', 'adjudication')),
        target_sha text not null,
        target_base_sha text not null,
        patch_identity text not null,
        decision text not null check (decision in ('approve', 'needs_rework', 'needs_human', 'blocked')),
        findings_json text not null check (json_valid(findings_json)),
        created_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table review_sets (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        target_sha text not null,
        target_base_sha text not null,
        patch_identity text not null,
        required_reviewer_roles_json text not null check (json_valid(required_reviewer_roles_json)),
        required_specialist_names_json text not null check (json_valid(required_specialist_names_json)),
        verification_record_id text not null references verification_records(id),
        guard_decision_ids_json text not null check (json_valid(guard_decision_ids_json)),
        review_record_ids_json text not null check (json_valid(review_record_ids_json)),
        unresolved_blocking_finding_ids_json text not null check (json_valid(unresolved_blocking_finding_ids_json)),
        carried_from_review_set_id text references review_sets(id),
        carry_forward_guard_decision_id text,
        decision text not null check (decision in ('approve', 'needs_rework', 'needs_human', 'blocked')),
        created_at text not null,
        check ((carried_from_review_set_id is null) = (carry_forward_guard_decision_id is null))
      ) strict
    `.execute(database);
    await sql`
      create table guard_decisions (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        requested_transition text not null,
        result text not null check (result in ('allow', 'deny')),
        reason_code text not null,
        evidence_json text not null check (json_valid(evidence_json)),
        created_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table lessons (
        id text primary key,
        created_at text not null,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        source text not null check (source in ('guard_denial', 'rework', 'review_finding', 'escaped_defect', 'plan_rejection', 'tool_failure', 'budget_exhausted', 'confusion')),
        text text not null,
        evidence_json text not null check (json_valid(evidence_json))
      ) strict
    `.execute(database);
    await sql`
      create table rules (
        id text primary key,
        text text not null,
        lesson_ids_json text not null check (json_valid(lesson_ids_json)),
        citation_count integer not null default 0 check (citation_count >= 0),
        last_cited_at text
      ) strict
    `.execute(database);
    await sql`
      create table live_sessions (
        attempt_id text primary key references attempts(id),
        session_id text not null,
        thread_id text not null,
        turn_id text,
        process_id integer not null check (process_id >= 0),
        process_group_id integer not null check (process_group_id >= 0),
        adapter_version text not null,
        protocol_schema_hash text not null,
        last_event text not null,
        last_event_at text not null,
        turn_count integer not null default 0 check (turn_count >= 0),
        last_input_tokens integer not null default 0 check (last_input_tokens >= 0),
        last_output_tokens integer not null default 0 check (last_output_tokens >= 0),
        last_total_tokens integer not null default 0 check (last_total_tokens = last_input_tokens + last_output_tokens),
        ownership_verified_at text
      ) strict
    `.execute(database);
    await sql`
      create table retry_entries (
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text not null references attempts(id),
        failure_class text not null,
        retry_number integer not null check (retry_number > 0),
        due_at text not null,
        max_retries integer not null check (max_retries >= 0),
        last_error text not null,
        created_at text not null,
        primary key (work_ref_kind, work_ref_id, retry_number)
      ) strict
    `.execute(database);
    await sql`
      create table parked_work (
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        origin_stage text not null,
        reason text not null,
        blocker_predicate text,
        question_id text,
        parked_at text not null,
        last_checked_at text not null,
        resolved_at text,
        primary key (work_ref_kind, work_ref_id)
      ) strict
    `.execute(database);
    await sql`
      create table operator_questions (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text not null references attempts(id),
        text text not null,
        options_json text not null check (json_valid(options_json)),
        default_answer text not null,
        comment_marker text not null,
        comment_cursor text,
        asked_at text not null,
        reminded_at text,
        answered_at text,
        answer text,
        answered_by text,
        check (
          (answered_at is null and answer is null and answered_by is null)
          or (answered_at is not null and answer is not null and answered_by is not null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table agent_approval_requests (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text not null references attempts(id),
        action_kind text not null,
        scope text not null,
        summary text not null,
        requested_at text not null,
        expires_at text not null,
        status text not null check (status in ('pending', 'approved', 'denied', 'expired')),
        decided_at text,
        decided_by text,
        decision text
      ) strict
    `.execute(database);
    await sql`
      create table mutation_authorizations (
        id text primary key,
        intent_id text not null unique,
        idempotency_key text not null,
        scope text not null check (scope in ('work', 'fleet')),
        work_ref_kind text check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text,
        service_run_id text not null references service_runs(id),
        actor_kind text not null check (actor_kind in ('orchestrator_policy', 'operator')),
        actor_id text not null,
        attempt_role text,
        operator_capability text,
        config_snapshot_id text not null references config_snapshots(id),
        action text not null,
        target text not null,
        observed_state_ref text not null,
        target_revision text,
        decision_rule_ids_json text not null check (json_valid(decision_rule_ids_json)),
        authorized_at text not null,
        expires_at text not null,
        check (
          (scope = 'work' and work_ref_kind is not null and work_ref_id is not null)
          or (scope = 'fleet' and work_ref_kind is null and work_ref_id is null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table side_effect_intents (
        id text primary key,
        idempotency_key text not null unique,
        scope text not null check (scope in ('work', 'fleet')),
        work_ref_kind text check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text,
        service_run_id text not null references service_runs(id),
        attempt_id text references attempts(id),
        action text not null,
        target text not null,
        target_revision text,
        request_payload_hash text not null,
        authorization_id text not null unique references mutation_authorizations(id),
        status text not null check (status in ('pending', 'applying', 'applied', 'failed', 'unknown')),
        created_at text not null,
        updated_at text not null,
        check (
          (scope = 'work' and work_ref_kind is not null and work_ref_id is not null)
          or (scope = 'fleet' and work_ref_kind is null and work_ref_id is null)
        )
      ) strict
    `.execute(database);
    await sql`
      create table side_effect_receipts (
        intent_id text primary key references side_effect_intents(id),
        provider_request_id text not null,
        result text not null,
        result_revision text,
        response_payload_hash text not null,
        applied_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table repository_links (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        cycle integer not null check (cycle > 0),
        kind text not null check (kind in ('primary', 'repair')),
        repo_owner text not null,
        repo_name text not null,
        branch text not null,
        pull_request_number integer not null check (pull_request_number > 0),
        pull_request_url text not null,
        head_sha text not null,
        base_ref text not null,
        base_sha text not null,
        state text not null,
        created_at text not null,
        updated_at text not null,
        unique (work_ref_kind, work_ref_id, cycle, kind)
      ) strict
    `.execute(database);
    await sql`
      create table plans (
        id text primary key,
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        revision integer not null check (revision > 0),
        status text not null check (status in ('draft', 'validated', 'approved', 'rejected', 'superseded')),
        approach text not null,
        acceptance_criteria_json text not null check (json_valid(acceptance_criteria_json)),
        proposed_paths_json text not null check (json_valid(proposed_paths_json)),
        verification_commands_json text not null check (json_valid(verification_commands_json)),
        estimated_files integer not null check (estimated_files >= 0),
        estimated_changed_lines integer not null check (estimated_changed_lines >= 0),
        risk_facts_json text not null check (json_valid(risk_facts_json)),
        created_by_attempt_id text not null references attempts(id),
        created_at text not null,
        validated_at text,
        approved_by_attempt_id text references attempts(id),
        unique (work_ref_kind, work_ref_id, revision)
      ) strict
    `.execute(database);
    await sql`
      create table log_records (
        id text primary key,
        service_run_id text not null references service_runs(id),
        work_ref_kind text check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text,
        attempt_id text references attempts(id),
        session_id text,
        stage_transition_id text references stage_transitions(id),
        timestamp text not null,
        level text not null check (level in ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
        event_name text not null,
        message text not null,
        structured_fields_json text not null check (json_valid(structured_fields_json)),
        check ((work_ref_kind is null) = (work_ref_id is null))
      ) strict
    `.execute(database);
    await sql`
      create index log_records_timeline on log_records (timestamp, id)
    `.execute(database);
    await sql`
      create table usage_samples (
        id text primary key,
        service_run_id text not null references service_runs(id),
        work_ref_kind text not null check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text not null,
        attempt_id text references attempts(id),
        system_job_id text references system_jobs(id),
        timestamp text not null,
        input_tokens integer not null check (input_tokens >= 0),
        output_tokens integer not null check (output_tokens >= 0),
        total_tokens integer not null check (total_tokens = input_tokens + output_tokens),
        billable_categories_json text not null check (json_valid(billable_categories_json)),
        derived_input_tokens integer not null check (derived_input_tokens >= 0),
        derived_output_tokens integer not null check (derived_output_tokens >= 0),
        derived_total_tokens integer not null check (derived_total_tokens = derived_input_tokens + derived_output_tokens),
        cost_usd real check (cost_usd is null or cost_usd >= 0),
        check ((attempt_id is not null) != (system_job_id is not null))
      ) strict
    `.execute(database);
    await sql`
      create index usage_samples_rolling on usage_samples (timestamp, id)
    `.execute(database);
    await sql`
      create table budget_adjustments (
        id text primary key,
        ledger_id text not null references budget_ledgers(id),
        action text not null check (action in ('set_limit', 'add_allowance', 'start_new_allowance_epoch')),
        amount real not null,
        reason text not null,
        operator_action_id text not null unique references operator_actions(id),
        prior_version integer not null check (prior_version >= 0),
        new_version integer not null check (new_version = prior_version + 1),
        created_at text not null
      ) strict
    `.execute(database);
  },
  version: 5,
};

const verificationEvidenceMigration: RepositoryMigration = {
  checksum: "sha256:fd6857c276cdf3cd13512a7f1ba7e6d58b7d3971ab151bf1f070036f91003ef7",
  name: "verification_evidence_blobs",
  async up(database) {
    await sql`
      create table evidence_blobs (
        id text primary key,
        media_type text not null,
        byte_length integer not null check (byte_length >= 0),
        content blob not null,
        created_at text not null,
        check (length(content) = byte_length)
      ) strict
    `.execute(database);
  },
  version: 6,
};

const appendOnlyEventRecordsMigration: RepositoryMigration = {
  checksum: "sha256:72b0bc278ad67b56c07edb7c038f50d91a92749761800110d86ea0d76e165bb6",
  name: "append_only_event_records",
  async up(database) {
    await sql`
      create table event_records (
        cursor integer primary key autoincrement,
        id text not null unique,
        service_run_id text not null references service_runs(id),
        work_ref_kind text check (work_ref_kind in ('issue', 'system_job')),
        work_ref_id text,
        attempt_id text references attempts(id),
        compute_profile text check (compute_profile in ('economy', 'standard', 'deep')),
        change_class text check (change_class in ('trivial', 'standard', 'high_risk')),
        timestamp text not null,
        event_name text not null,
        result text not null,
        reason_code text not null,
        cost_usd real check (cost_usd is null or cost_usd >= 0),
        payload_json text not null check (json_valid(payload_json)),
        check ((work_ref_kind is null) = (work_ref_id is null)),
        check ((attempt_id is null) = (compute_profile is null)),
        check (attempt_id is null or work_ref_kind is not null)
      ) strict
    `.execute(database);
    await sql`
      create index event_records_work_timeline
      on event_records (work_ref_kind, work_ref_id, cursor)
    `.execute(database);
  },
  version: 7,
};

const operatorIdentityMigration: RepositoryMigration = {
  checksum: "sha256:b4b274d793d207ac75b72bcf46a88541e0b36b77ea6231e80e449e4c0f4aa1f5",
  name: "operator_identity_and_sessions",
  async up(database) {
    await sql`
      create table operators (
        id text primary key,
        auth_subject text not null unique,
        capabilities_json text not null check (json_valid(capabilities_json)),
        tracker_login text unique,
        status text not null check (status in ('active', 'revoked')),
        version integer not null check (version > 0),
        created_at text not null,
        updated_at text not null
      ) strict
    `.execute(database);
    await sql`
      create table local_operator_credentials (
        operator_id text primary key references operators(id) on delete restrict,
        algorithm text not null check (algorithm = 'scrypt'),
        salt blob not null,
        verifier blob not null,
        parameters_json text not null check (json_valid(parameters_json)),
        created_at text not null,
        rotated_at text
      ) strict
    `.execute(database);
    await sql`
      create table operator_sessions (
        token_hash text primary key,
        operator_id text not null references operators(id) on delete restrict,
        auth_subject text not null,
        csrf_token_hash text not null,
        operator_version integer not null check (operator_version > 0),
        issued_at text not null,
        expires_at text not null,
        last_seen_at text not null,
        revoked_at text,
        check (expires_at > issued_at)
      ) strict
    `.execute(database);
    await sql`
      create index operator_sessions_operator on operator_sessions (operator_id, expires_at)
    `.execute(database);
    await sql`
      create table bootstrap_state (
        singleton integer primary key check (singleton = 1),
        candidate_hash text not null unique,
        operator_id text not null unique references operators(id),
        config_snapshot_id text not null unique references config_snapshots(id),
        operator_action_id text not null unique references operator_actions(id),
        consumed_at text not null
      ) strict
    `.execute(database);
  },
  version: 8,
};

const startupFailureMigration: RepositoryMigration = {
  checksum: "sha256:6b42a49bdba3bcda6e96ab6f83b13b7d573ca5c28949e53b2d768afc36c31233",
  name: "startup_failure_records",
  async up(database) {
    await sql`
      create table startup_failures (
        id text primary key,
        occurred_at text not null,
        reason_code text not null,
        details_json text not null check (json_valid(details_json))
      ) strict
    `.execute(database);
  },
  version: 9,
};

const activeSynthesisJobMigration: RepositoryMigration = {
  checksum: "sha256:24d596121d1d5179d1457e89076ed67812974969d995e8aa1854c6315ce9e74f",
  name: "active_synthesis_job_guard",
  async up(database) {
    await sql`
      create unique index system_jobs_one_active_synthesis
      on system_jobs (kind)
      where kind = 'synthesis' and status not in ('done', 'failed')
    `.execute(database);
  },
  version: 10,
};

export const CORE_MIGRATIONS = [
  coreControlPlaneMigration,
  stageTransitionMigration,
  configurationOverrideMigration,
  configurationAcknowledgmentMigration,
  durableDomainRecordsMigration,
  verificationEvidenceMigration,
  appendOnlyEventRecordsMigration,
  operatorIdentityMigration,
  startupFailureMigration,
  activeSynthesisJobMigration,
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
