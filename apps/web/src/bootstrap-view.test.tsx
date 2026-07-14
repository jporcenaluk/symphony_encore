import type { BootstrapResponse, ControlApiClient } from "@symphony/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BootstrapView, submitBootstrap } from "./bootstrap-view.js";

describe("first-run bootstrap view", () => {
  it("shows the complete candidate and requires an independently entered confirmation", () => {
    const markup = renderToStaticMarkup(
      <BootstrapView
        candidateHash="sha256:complete-candidate"
        completeBootstrap={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    expect(markup).toContain("First-run authority");
    expect(markup).toContain("sha256:complete-candidate");
    expect(markup).toContain('for="confirmed-candidate-hash"');
    expect(markup).not.toContain('value="sha256:complete-candidate"');
    expect(markup).toContain('for="bootstrap-credential"');
    expect(markup).toContain('type="password"');
  });

  it("submits the exact local authority fields without returning either secret", async () => {
    const complete = vi.fn(
      async (): Promise<BootstrapResponse> => ({ status: "completed" }),
    ) as ControlApiClient["completeBootstrap"];
    const result = await submitBootstrap(complete, {
      authSubject: "local:admin",
      bootstrapCredential: "one-time-secret",
      confirmedCandidateHash: "sha256:complete-candidate",
      password: "strong local password",
      trackerLogin: "octocat",
    });

    expect(result).toEqual({ kind: "completed" });
    expect(complete).toHaveBeenCalledWith({
      auth_subject: "local:admin",
      bootstrap_credential: "one-time-secret",
      confirmed_candidate_hash: "sha256:complete-candidate",
      password: "strong local password",
      tracker_login: "octocat",
    });
    expect(JSON.stringify(result)).not.toContain("one-time-secret");
    expect(JSON.stringify(result)).not.toContain("strong local password");
  });
});
