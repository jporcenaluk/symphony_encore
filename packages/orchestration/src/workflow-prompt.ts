const WORKFLOW_PROMPT_ROOTS = [
  "work_ref",
  "issue",
  "system_job",
  "attempt",
  "change_class",
  "plan",
  "rules",
] as const;

type WorkflowPromptRoot = (typeof WORKFLOW_PROMPT_ROOTS)[number];

export type WorkflowPromptContext = Readonly<Record<WorkflowPromptRoot, unknown>>;

const ROOTS = new Set<string>(WORKFLOW_PROMPT_ROOTS);
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const EXPRESSION = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

interface Interpolation {
  readonly end: number;
  readonly expression: string;
  readonly start: number;
}

export function validateWorkflowPromptTemplate(prompt: string): void {
  parseInterpolations(prompt);
}

export function renderWorkflowPrompt(prompt: string, context: WorkflowPromptContext): string {
  const interpolations = parseInterpolations(prompt);
  const rendered: string[] = [];
  let cursor = 0;
  for (const interpolation of interpolations) {
    rendered.push(prompt.slice(cursor, interpolation.start));
    rendered.push(
      renderValue(resolveValue(interpolation.expression, context), interpolation.expression),
    );
    cursor = interpolation.end;
  }
  rendered.push(prompt.slice(cursor));
  return rendered.join("");
}

function parseInterpolations(prompt: string): Interpolation[] {
  const interpolations: Interpolation[] = [];
  let cursor = 0;
  while (cursor < prompt.length) {
    const start = prompt.indexOf("{{", cursor);
    const strayEnd = prompt.indexOf("}}", cursor);
    if (strayEnd !== -1 && (start === -1 || strayEnd < start)) {
      throw new Error("workflow.template_unterminated");
    }
    if (start === -1) break;
    const closing = prompt.indexOf("}}", start + 2);
    if (closing === -1) throw new Error("workflow.template_unterminated");
    const expression = prompt.slice(start + 2, closing).trim();
    validateExpression(expression);
    interpolations.push({ end: closing + 2, expression, start });
    cursor = closing + 2;
  }
  return interpolations;
}

function validateExpression(source: string): string[] {
  const expression = source.trim();
  if (expression.includes("|")) throw new Error("workflow.template_filter_forbidden");
  if (!EXPRESSION.test(expression)) {
    throw new Error(`workflow.template_unknown_variable:${expression}`);
  }
  const segments = expression.split(".");
  if (!ROOTS.has(segments[0] ?? "")) {
    throw new Error(`workflow.template_unknown_variable:${expression}`);
  }
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    throw new Error(`workflow.template_unsafe_variable:${expression}`);
  }
  return segments;
}

function resolveValue(expression: string, context: WorkflowPromptContext): unknown {
  const segments = validateExpression(expression);
  let current: unknown = context;
  for (const segment of segments) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      throw new Error(`workflow.template_unknown_variable:${expression}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`workflow.template_unknown_variable:${expression}`);
  }
  return current;
}

function renderValue(value: unknown, expression: string): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") return canonicalJson(value, expression, new Set<object>());
  throw new Error(`workflow.template_value_invalid:${expression}`);
}

function canonicalJson(value: unknown, expression: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isFinite(value)) return JSON.stringify(value);
    throw new Error(`workflow.template_value_invalid:${expression}`);
  }
  if (typeof value !== "object") throw new Error(`workflow.template_value_invalid:${expression}`);
  if (ancestors.has(value)) throw new Error(`workflow.template_value_invalid:${expression}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, expression, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`workflow.template_value_invalid:${expression}`);
    }
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, unknown>)[key],
            expression,
            ancestors,
          )}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
