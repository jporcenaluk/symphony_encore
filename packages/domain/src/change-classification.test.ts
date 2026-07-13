import { describe, expect, it } from "vitest";

import {
  type ClassificationFacts,
  classifyAuthoritatively,
  classifyProvisionally,
  reclassify,
} from "./change-classification.js";

const safeTrivialFacts: ClassificationFacts = {
  acceptanceCriteriaPresent: true,
  changedLines: 8,
  everyPathMatchesTrivialPattern: true,
  riskFacts: [],
  standardFacts: [],
};

describe("change classification", () => {
  it("uses standard provisionally when pre-plan facts are unknown", () => {
    expect(
      classifyProvisionally({
        acceptanceCriteriaPresent: true,
        riskFacts: [],
        standardFacts: [],
      }),
    ).toEqual({ changeClass: "standard", floor: null, reasons: ["classification.unknown"] });
  });

  it("lets an unknown-only provisional standard become the first authoritative trivial", () => {
    const provisional = classifyProvisionally({
      acceptanceCriteriaPresent: true,
      riskFacts: [],
      standardFacts: [],
    });

    expect(
      classifyAuthoritatively(provisional, safeTrivialFacts, {
        trivialMaxChangedLines: 25,
        trivialPatternsConfigured: true,
      }),
    ).toEqual({
      changeClass: "trivial",
      reasons: ["classification.trivial_paths", "classification.trivial_size"],
    });
  });

  it("keeps an explicit standard fact as an authoritative floor", () => {
    const provisional = classifyProvisionally({
      acceptanceCriteriaPresent: true,
      riskFacts: [],
      standardFacts: ["change.cross_package_non_public"],
    });

    expect(
      classifyAuthoritatively(provisional, safeTrivialFacts, {
        trivialMaxChangedLines: 25,
        trivialPatternsConfigured: true,
      }),
    ).toEqual({
      changeClass: "standard",
      reasons: ["change.cross_package_non_public"],
    });
  });

  it("classifies ambiguous criteria and other risk facts as high risk", () => {
    expect(
      classifyProvisionally({
        acceptanceCriteriaPresent: false,
        riskFacts: ["risk.migration_data"],
        standardFacts: [],
      }),
    ).toEqual({
      changeClass: "high_risk",
      floor: "high_risk",
      reasons: ["risk.ambiguous_criteria", "risk.migration_data"],
    });
  });

  it("never moves downward after the first authoritative class", () => {
    expect(
      reclassify(
        "high_risk",
        safeTrivialFacts,
        { trivialMaxChangedLines: 25, trivialPatternsConfigured: true },
        null,
      ),
    ).toEqual({
      changeClass: "high_risk",
      reasons: ["classification.upward_only"],
    });
  });

  it("moves upward when the final diff exposes a risk", () => {
    expect(
      reclassify(
        "trivial",
        { ...safeTrivialFacts, riskFacts: ["risk.security_auth"] },
        { trivialMaxChangedLines: 25, trivialPatternsConfigured: true },
        null,
      ),
    ).toEqual({
      changeClass: "high_risk",
      reasons: ["risk.security_auth"],
    });
  });
});
