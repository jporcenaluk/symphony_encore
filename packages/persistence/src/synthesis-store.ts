import type { EvidenceRef, Lesson, Rule } from "@symphony/contracts";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "./database.js";

export interface SynthesisMetric {
  attemptCount: number;
  changeClass: "high_risk" | "standard" | "trivial";
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  role: string;
}

export interface SynthesisTriggerState {
  activeSynthesisJobs: number;
  completedIssuesSinceLastSynthesis: number;
  decayedRuleIds: string[];
  lastSynthesisEndedAt: string | null;
  lessons: Lesson[];
  metrics: SynthesisMetric[];
  rules: Rule[];
}

export interface SynthesisValidationState {
  knownLessonIds: string[];
  rules: Rule[];
}

interface LessonRow {
  created_at: string;
  evidence_json: string;
  id: string;
  source: Lesson["source"];
  text: string;
  work_ref_id: string;
  work_ref_kind: "issue" | "system_job";
}

interface LessonTimeRow {
  created_at: string;
  id: string;
}

interface MetricRow {
  attempt_count: number;
  change_class: SynthesisMetric["changeClass"];
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  role: string;
}

interface RuleRow {
  citation_count: number;
  id: string;
  last_cited_at: string | null;
  lesson_ids_json: string;
  text: string;
}

export async function loadSynthesisTriggerState(
  database: Kysely<DatabaseSchema>,
  input: { ruleDecayIssues: number },
): Promise<SynthesisTriggerState> {
  if (!Number.isSafeInteger(input.ruleDecayIssues) || input.ruleDecayIssues < 1) {
    throw new Error("synthesis.rule_decay_issues_invalid");
  }
  return database.transaction().execute(async (transaction) => {
    const terminal = await sql<{ ended_at: string | null }>`
      select max(ended_at) as ended_at from system_jobs
      where kind = 'synthesis' and status in ('done', 'failed') and ended_at is not null
    `.execute(transaction);
    const lastSynthesisEndedAt = terminal.rows[0]?.ended_at ?? null;
    const completionRows = await sql<{ entered_at: string }>`
      select entered_at from stage_transitions
      where work_ref_kind = 'issue' and to_stage = 'Done'
        and (${lastSynthesisEndedAt} is null or entered_at > ${lastSynthesisEndedAt})
      order by entered_at, id
    `.execute(transaction);
    const active = await sql<{ count: number }>`
      select count(*) as count from system_jobs
      where kind = 'synthesis' and status not in ('done', 'failed')
    `.execute(transaction);
    const lessons = await sql<LessonRow>`
      select * from lessons
      where ${lastSynthesisEndedAt} is null or created_at > ${lastSynthesisEndedAt}
      order by created_at, id
    `.execute(transaction);
    const lessonTimes = await sql<LessonTimeRow>`
      select id, created_at from lessons order by created_at, id
    `.execute(transaction);
    const rules = await sql<RuleRow>`select * from rules order by id`.execute(transaction);
    const metrics = await sql<MetricRow>`
      select change_class, role, count(*) as attempt_count,
             sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
             case when count(cost_usd) = count(*) then sum(cost_usd) else null end as cost_usd
      from attempts
      where status = 'closed'
        and (${lastSynthesisEndedAt} is null or ended_at > ${lastSynthesisEndedAt})
      group by change_class, role
      order by change_class, role
    `.execute(transaction);
    return {
      activeSynthesisJobs: active.rows[0]?.count ?? 0,
      completedIssuesSinceLastSynthesis: completionRows.rows.length,
      decayedRuleIds: rules.rows
        .filter((rule) =>
          isRuleDecayed(
            rule,
            lessonTimes.rows,
            completionRows.rows.map((completion) => completion.entered_at),
            input.ruleDecayIssues,
          ),
        )
        .map((rule) => rule.id),
      lastSynthesisEndedAt,
      lessons: lessons.rows.map(toLesson),
      metrics: metrics.rows.map((metric) => ({
        attemptCount: metric.attempt_count,
        changeClass: metric.change_class,
        costUsd: metric.cost_usd,
        inputTokens: metric.input_tokens,
        outputTokens: metric.output_tokens,
        role: metric.role,
      })),
      rules: rules.rows.map(toRule),
    };
  });
}

export async function loadSynthesisValidationState(
  database: Kysely<DatabaseSchema>,
): Promise<SynthesisValidationState> {
  const [lessons, rules] = await Promise.all([
    sql<{ id: string }>`select id from lessons order by id`.execute(database),
    sql<RuleRow>`select * from rules order by id`.execute(database),
  ]);
  return {
    knownLessonIds: lessons.rows.map((lesson) => lesson.id),
    rules: rules.rows.map(toRule),
  };
}

function isRuleDecayed(
  rule: RuleRow,
  lessons: readonly LessonTimeRow[],
  completionTimes: readonly string[],
  ruleDecayIssues: number,
): boolean {
  const lessonIds = parseStringArray(rule.lesson_ids_json, "synthesis.rule_lessons_invalid");
  const lessonTimes = lessons
    .filter((lesson) => lessonIds.includes(lesson.id))
    .map((lesson) => lesson.created_at);
  const baseline = rule.last_cited_at ?? lessonTimes.sort()[0] ?? null;
  if (baseline === null) throw new Error(`synthesis.rule_evidence_missing:${rule.id}`);
  return completionTimes.filter((timestamp) => timestamp > baseline).length >= ruleDecayIssues;
}

function toLesson(row: LessonRow): Lesson {
  const evidence: unknown = JSON.parse(row.evidence_json);
  if (!Array.isArray(evidence)) throw new Error(`synthesis.lesson_evidence_invalid:${row.id}`);
  return {
    created_at: row.created_at,
    evidence: evidence as EvidenceRef[],
    id: row.id,
    source: row.source,
    text: row.text,
    work_ref:
      row.work_ref_kind === "issue"
        ? { issue_id: row.work_ref_id }
        : { system_job_id: row.work_ref_id },
  };
}

function toRule(row: RuleRow): Rule {
  return {
    citation_count: row.citation_count,
    id: row.id,
    last_cited_at: row.last_cited_at,
    lesson_ids: parseStringArray(row.lesson_ids_json, `synthesis.rule_lessons_invalid:${row.id}`),
    text: row.text,
  };
}

function parseStringArray(value: string, error: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item)) {
    throw new Error(error);
  }
  return parsed;
}
