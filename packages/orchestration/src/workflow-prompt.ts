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
const INTERPOLATION = /\{\{([\s\S]*?)\}\}/gu;

export function validateWorkflowPromptTemplate(prompt: string): void {
  const unmatched = prompt.replace(INTERPOLATION, "");
  if (unmatched.includes("{{") || unmatched.includes("}}")) {
    throw new Error("workflow.template_unterminated");
  }
  for (const match of prompt.matchAll(INTERPOLATION)) validateExpression(match[1] ?? "");
}

export function renderWorkflowPrompt(prompt: string, context: WorkflowPromptContext): string {
  validateWorkflowPromptTemplate(prompt);
  return prompt.replace(INTERPOLATION, (_token, source: string) => {
    const expression = source.trim();
    return renderValue(resolveValue(expression, context), expression);
  });
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
