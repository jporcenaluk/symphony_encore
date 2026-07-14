const RULES_START = "<!-- rules:start -->";
const RULES_END = "<!-- rules:end -->";

export function rulesBlock(prompt: string): string {
  const start = prompt.indexOf(RULES_START);
  if (start === -1) return "";
  const contentStart = start + RULES_START.length;
  const end = prompt.indexOf(RULES_END, contentStart);
  return end === -1 ? "" : prompt.slice(contentStart, end).trim();
}

export function pathFromRoot(root: string, suffix: string): string {
  let end = root.length;
  while (end > 0 && root.charCodeAt(end - 1) === 0x2f) end -= 1;
  return `${root.slice(0, end)}/${suffix}`;
}
