import type { PullRequestSnapshot } from "@symphony/contracts";
import { describe, expect, it } from "vitest";

import { evaluatePostMergeChecks, hasAuthorizedMergeApproval } from "./merge-queue.js";

const snapshot: PullRequestSnapshot = {
  base_ref: "main",
  checks: [],
  head_sha: "def5678",
  is_draft: false,
  mergeable: true,
  observed_base_sha: "abc1234",
  post_merge_checks: [],
  pr_number: 42,
  pr_state: "open",
  pr_url: "https://github.com/owner/repo/pull/42",
  required_check_source: "configured",
  review_decision: "approved",
  reviews: [],
  unresolved_threads: [],
};

describe("merge queue", () => {
  it("accepts only the authorized reviewer's latest current-head approval", () => {
    expect(
      hasAuthorizedMergeApproval(
        {
          ...snapshot,
          reviews: [
            {
              author: "maintainer",
              commit_sha: "def5678",
              state: "approved",
              submitted_at: "2026-07-13T10:00:00Z",
            },
          ],
        },
        ["maintainer"],
      ),
    ).toBe(true);
    expect(
      hasAuthorizedMergeApproval(
        {
          ...snapshot,
          reviews: [
            {
              author: "maintainer",
              commit_sha: "def5678",
              state: "approved",
              submitted_at: "2026-07-13T10:00:00Z",
            },
            {
              author: "maintainer",
              commit_sha: "def5678",
              state: "changes_requested",
              submitted_at: "2026-07-13T10:01:00Z",
            },
          ],
        },
        ["maintainer"],
      ),
    ).toBe(false);
    expect(
      hasAuthorizedMergeApproval(
        {
          ...snapshot,
          reviews: [
            {
              author: "maintainer",
              commit_sha: "aaaaaaa",
              state: "approved",
              submitted_at: "2026-07-13T10:00:00Z",
            },
          ],
        },
        ["maintainer"],
      ),
    ).toBe(false);
  });

  it("waits for current merge checks and fails closed on a terminal rejection", () => {
    expect(
      evaluatePostMergeChecks(
        [
          {
            conclusion: null,
            name: "deploy / staging",
            status: "in_progress",
            target_sha: "fedcba9",
            url: "https://github.com/owner/repo/actions/runs/2",
          },
        ],
        "fedcba9",
        ["deploy / staging"],
        ["success"],
      ),
    ).toEqual({ decision: "wait", reason: "post_merge.check_pending:deploy / staging" });
    expect(
      evaluatePostMergeChecks(
        [
          {
            conclusion: "failure",
            name: "deploy / staging",
            status: "completed",
            target_sha: "fedcba9",
            url: "https://github.com/owner/repo/actions/runs/2",
          },
        ],
        "fedcba9",
        ["deploy / staging"],
        ["success"],
      ),
    ).toEqual({ decision: "fail", reason: "post_merge.check_failed:deploy / staging:failure" });
    expect(
      evaluatePostMergeChecks(
        [
          {
            conclusion: "success",
            name: "deploy / staging",
            status: "completed",
            target_sha: "fedcba9",
            url: "https://github.com/owner/repo/actions/runs/2",
          },
        ],
        "fedcba9",
        ["deploy / staging"],
        ["success"],
      ),
    ).toEqual({ decision: "allow" });
  });
});
