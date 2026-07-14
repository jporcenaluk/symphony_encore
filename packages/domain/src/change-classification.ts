export type ChangeClass = "trivial" | "standard" | "high_risk";

export interface ProvisionalFacts {
  acceptanceCriteriaPresent: boolean;
  riskFacts: readonly string[];
  standardFacts: readonly string[];
}

export interface ClassificationFacts extends ProvisionalFacts {
  changedLines: number;
  everyPathMatchesTrivialPattern: boolean;
}

export interface ClassificationConfig {
  trivialMaxChangedLines: number;
  trivialPatternsConfigured: boolean;
}

export interface ProvisionalClassification {
  changeClass: "standard" | "high_risk";
  floor: "standard" | "high_risk" | null;
  reasons: readonly string[];
}

export interface AuthoritativeClassification {
  changeClass: ChangeClass;
  reasons: readonly string[];
}

const CLASS_RANK: Readonly<Record<ChangeClass, number>> = {
  trivial: 0,
  standard: 1,
  high_risk: 2,
};

function riskReasons(facts: ProvisionalFacts): string[] {
  return [
    ...(facts.acceptanceCriteriaPresent ? [] : ["risk.ambiguous_criteria"]),
    ...facts.riskFacts,
  ];
}

export function classifyProvisionally(facts: ProvisionalFacts): ProvisionalClassification {
  const risks = riskReasons(facts);
  if (risks.length > 0) {
    return { changeClass: "high_risk", floor: "high_risk", reasons: risks };
  }
  if (facts.standardFacts.length > 0) {
    return {
      changeClass: "standard",
      floor: "standard",
      reasons: [...facts.standardFacts],
    };
  }
  return {
    changeClass: "standard",
    floor: null,
    reasons: ["classification.unknown"],
  };
}

function classifyFacts(
  facts: ClassificationFacts,
  config: ClassificationConfig,
  floor: ProvisionalClassification["floor"],
  floorReasons: readonly string[],
): AuthoritativeClassification {
  const risks = riskReasons(facts);
  if (risks.length > 0 || floor === "high_risk") {
    return {
      changeClass: "high_risk",
      reasons: risks.length > 0 ? risks : [...floorReasons],
    };
  }
  if (floor === "standard") {
    return { changeClass: "standard", reasons: [...floorReasons] };
  }
  if (
    config.trivialPatternsConfigured &&
    facts.everyPathMatchesTrivialPattern &&
    facts.changedLines <= config.trivialMaxChangedLines
  ) {
    return {
      changeClass: "trivial",
      reasons: ["classification.trivial_paths", "classification.trivial_size"],
    };
  }
  return {
    changeClass: "standard",
    reasons: [
      ...(config.trivialPatternsConfigured
        ? []
        : ["classification.no_trivial_patterns_configured"]),
      ...(facts.everyPathMatchesTrivialPattern ? [] : ["classification.nontrivial_path"]),
      ...(facts.changedLines <= config.trivialMaxChangedLines
        ? []
        : ["classification.size_exceeded"]),
    ],
  };
}

export function classifyAuthoritatively(
  provisional: ProvisionalClassification,
  facts: ClassificationFacts,
  config: ClassificationConfig,
): AuthoritativeClassification {
  return classifyFacts(facts, config, provisional.floor, provisional.reasons);
}

export function reclassify(
  current: ChangeClass,
  facts: ClassificationFacts,
  config: ClassificationConfig,
  provisionalFloor: ProvisionalClassification["floor"],
): AuthoritativeClassification {
  const candidate = classifyFacts(facts, config, provisionalFloor, []);
  if (CLASS_RANK[candidate.changeClass] < CLASS_RANK[current]) {
    return { changeClass: current, reasons: ["classification.upward_only"] };
  }
  return candidate;
}
