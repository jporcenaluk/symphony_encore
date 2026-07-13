# Symphony Encore Continuous Integration and Delivery Specification

Status: Draft v1

Purpose: Define the required local checks, GitHub pull-request gates, `main` branch validation,
artifact publication, dependency maintenance, and deployment controls for the Symphony Encore
reference implementation.

The key words MUST, MUST NOT, SHOULD, and MAY are used per RFC 2119. This document defines the
delivery contract; workflow YAML and repository settings implement it. A green workflow is evidence
only for the exact commit, inputs, toolchain, and workflow revision that produced it.

## 1. Delivery Principles

1. **One gate, several triggers.** Pull requests, merge-queue candidates, and `main` MUST run the
   same canonical verification commands. A second, weaker implementation of a check is forbidden.
2. **Reproducible and current.** Toolchains, dependencies, actions, and container bases are pinned.
   Automated pull requests keep those pins on the newest stable mutually compatible releases.
3. **Untrusted code gets no authority.** Pull-request code MUST run without repository, package,
   cloud, or deployment credentials and with a read-only token unless a narrower permission is
   required by an isolated trusted job.
4. **Build once after trust.** Deployable artifacts MUST be built from a verified `main` or release
   commit, identified by immutable digest, and promoted without rebuilding.
5. **Local feedback is fast; CI is authoritative.** Pre-commit hooks catch cheap mistakes. They MUST
   NOT replace server-side required checks, and bypassing a local hook MUST NOT bypass CI.
6. **Failures leave evidence.** Test reports, relevant logs, browser traces, coverage, SBOMs,
   attestations, and scan results MUST remain available long enough to diagnose the failing commit.
7. **No deployment target is invented.** Until a hosted environment is selected, successful `main`
   runs publish verified artifacts but MUST NOT claim a production deployment occurred.

## 2. Repository and Branch Controls

The default branch MUST be `main` and MUST be protected by a GitHub ruleset or equivalent branch
protection. Direct pushes to `main` are forbidden except for an explicitly audited break-glass role.

The protection policy MUST require:

- a pull request;
- the current required checks from Section 5;
- all review conversations resolved;
- the head branch to be current with the protected base or validated through GitHub's merge queue;
- at least one approving review once the repository has more than one maintainer;
- dismissal or invalidation of approval when the reviewed diff changes materially; and
- successful validation of the exact merge-group commit when merge queue is enabled.

The repository SHOULD use squash merging so `main` contains one intentional commit per pull request.
The pull-request title MUST follow the repository's Conventional Commit subset because it becomes
the squash subject. Merge commits and force pushes to `main` SHOULD be disabled.

`CODEOWNERS` MUST protect workflow files, dependency and toolchain configuration, container files,
migrations, authentication code, sandbox/process-control code, and release configuration once an
independent owner exists. A sole-maintainer repository MAY begin without an impossible self-approval
rule, but CI and conversation-resolution requirements still apply.

Required-check names MUST remain stable. A workflow refactor MUST update the ruleset in the same
administrative change and MUST NOT leave `main` accidentally unguarded.

## 3. Workflow Structure and Triggers

The repository SHOULD separate reusable verification logic from trigger-specific authority:

```text
.github/workflows/
  ci.yml                 pull_request, merge_group, push to main
  codeql.yml             pull_request, push to main, scheduled analysis
  publish-container.yml  build and publish verified main commits
  release.yml            promote existing artifacts for version tags
```

`ci.yml` MUST trigger on `pull_request`, `merge_group`, and pushes to `main`. The merge-group trigger
is REQUIRED when its checks are named in a merge-queue ruleset. Manual `workflow_dispatch` MAY be
provided for diagnosis, but its result MUST NOT be substituted for a required check on another SHA.

Pull-request concurrency SHOULD cancel an older run for the same pull request. `main`, merge-group,
release, and deployment runs MUST NOT be canceled merely because a newer commit appears; cancellation
could leave an artifact or environment in an unknown state.

Workflows MUST use repository-owned Make targets. YAML MUST coordinate jobs and permissions, not
duplicate build logic. The same `make verify` composition MUST be runnable on a contributor host.

## 4. Workflow Security

Every workflow MUST declare top-level `permissions: contents: read` or `permissions: {}` and grant
additional GitHub token permissions only to the job that needs them. Build and test jobs MUST NOT
receive write permissions.

Third-party and GitHub-authored actions MUST be pinned to a full commit SHA. A nearby comment SHOULD
record the corresponding release tag for human review. Floating tags such as `@main`, `@latest`, or
an unpinned major tag are forbidden in executed workflow steps. Automated dependency updates MUST
keep action SHAs current.

Workflows MUST NOT use `pull_request_target` to check out or execute untrusted pull-request content.
If a future metadata-only workflow needs `pull_request_target`, it MUST NOT fetch, evaluate, import,
or interpolate executable data from the pull request and MUST have an explicit threat-model review.

Untrusted issue titles, branch names, commit messages, pull-request bodies, and workflow inputs MUST
NOT be interpolated directly into shell scripts. Values MUST pass through environment variables or
structured action inputs and be quoted by the receiving program.

Secrets MUST NOT be available to ordinary pull-request jobs. Fork pull requests MUST receive the
same validation that can run safely without secrets. Deployment jobs MUST use GitHub Environments,
environment-specific protection, and OpenID Connect where the target supports it rather than
long-lived cloud credentials.

The repository MUST enable secret scanning and push protection when the GitHub plan permits them.
CI MUST run a repository secret scanner that can operate without receiving secrets of its own.

Workflow changes MUST pass actionlint and zizmor before merge. Generated workflow changes MUST
receive the same review as handwritten YAML. Gitleaks MUST provide the repository secret scan, and
Trivy MUST scan the final container filesystem when a Dockerfile exists. These tools are build-time
controls, not application runtime dependencies, and follow the pinning policy in Section 8.

CodeQL or an equivalent TypeScript static application-security analysis MUST run on pull requests,
pushes to `main`, and a regular schedule. Results MUST be uploaded to GitHub code scanning and MUST
identify the analyzed commit. A configured severity policy MUST block newly introduced actionable
findings; suppressions require a reviewed reason and scope.

## 5. Pull-Request and Merge-Queue Verification

The pull-request graph MUST expose stable required checks. Jobs MAY run in parallel after dependency
installation, but the final `ci / required` check MUST fail unless every required job for that commit
has passed or produced an explicitly permitted result.

### 5.1 Policy and Documentation

The policy job MUST:

- reject conflict markers, whitespace errors, and unexpected generated drift;
- validate Markdown links and normative-document formatting with Markdownlint CLI2;
- lint GitHub Actions and container definitions when present;
- validate the pnpm lockfile and workspace graph; and
- check the pull-request title convention.

Path filtering MAY skip work inside a job, but a required workflow MUST still report a terminal
status. GitHub path filters MUST NOT silently omit a required check and leave the pull request
unmergeable or, worse, unguarded.

### 5.2 Supply-Chain Review

Pull requests that change a supported package manifest or lockfile MUST run GitHub dependency review
or an equivalent manifest-aware gate. It MUST reject newly introduced packages with known
vulnerabilities at the configured severity threshold or licenses forbidden by project policy.

The review SHOULD surface dependency additions even when they pass, so reviewers can evaluate
maintenance, documentation, transitive size, native build requirements, and replacement cost.

Workflow-action changes MUST instead pass full-SHA pin validation, actionlint, and zizmor; package
dependency review MUST NOT be described as evidence about an action's executed code. Container-base
changes MUST resolve to an immutable digest. The built image's generated SBOM, vulnerability scan,
and configured license policy are the evidence for its final contents.

### 5.3 Static Verification

The static-verification job MUST use a frozen lockfile and run:

```text
Biome check
TypeScript type checking with no emit
package-boundary and cycle checks
generated OpenAPI/client drift checks
```

CI MUST fail rather than rewrite files. Formatting fixes belong in the contributor workspace.

### 5.4 Unit and Contract Tests

Vitest MUST run unit, contract, and component suites with deterministic time and randomness. Test
sharding MAY be introduced only when it preserves complete reporting and deterministic retries.
Failed tests MUST NOT be automatically retried into a green result without preserving the original
failure and identifying the test as flaky.

Coverage MUST be collected from the complete unit/contract suite. The initial floor MUST be based on
real measured coverage and SHOULD ratchet upward. A threshold reduction requires an explicit reason
in the pull request.

### 5.5 Persistence and Process Integration

Integration tests MUST use production migrations and temporary SQLite files. They MUST exercise:

- migration from every supported prior schema;
- transaction rollback and uniqueness constraints;
- claim and budget concurrency;
- restart and intent/receipt recovery;
- subprocess timeout, signal forwarding, and process-tree termination; and
- workspace path and symlink escape rejection.

Process and filesystem integration MUST run on Linux and macOS for changes that touch those
boundaries. The repository SHOULD keep a small cross-platform smoke suite on both hosted runner
types and run deeper platform suites on `main` and on a schedule if pull-request cost becomes
material.

WSL behavior MUST be covered by a documented release smoke test until a trustworthy automated WSL
runner is available. Linux CI alone MUST NOT be described as proof of Windows-host/WSL networking.

### 5.6 Production Build

The build job MUST create the production server and Vite assets from a frozen lockfile. It MUST start
the built server, verify its health and readiness endpoints, and prove that Fastify serves the
browser application and Control API from one port.

The build MUST fail on missing environment declarations, stale generated artifacts, or a browser
bundle that includes server-only modules or secret-bearing configuration.

### 5.7 Browser End-to-End Tests

Playwright MUST run against the built application, not only the Vite development server. The minimum
suite MUST cover bootstrap/login, the operations dashboard, issue history, live log reconnection,
settings validation, stale-version rejection, authorization failure, and safe rendering of hostile
issue/log content.

On failure, CI MUST retain the Playwright report, screenshots, traces, and relevant redacted server
logs. Browser tests MUST use synthetic credentials and data.

### 5.8 Container Verification

When the Dockerfile exists, pull requests MUST build the production image without publishing it. CI
MUST run the image as its declared non-root user, exercise health/readiness, confirm persistent paths,
inspect the effective user and entrypoint, and scan the final filesystem for known vulnerabilities
and accidentally included credentials.

The build context MUST exclude `.git`, local databases, workspaces, environment files, coverage,
browser artifacts, and dependency directories not intentionally copied by the multi-stage build.

## 6. Validation After Merge to `main`

Every push to `main` MUST rerun the complete canonical verification graph on the resulting commit.
The branch run MUST NOT trust a pull-request result for a different synthetic merge SHA. A failure on
`main` blocks publication and release from that commit and MUST be treated as a repository incident.

Successful `main` validation SHOULD produce:

- the built server and static UI bundle;
- a production OCI image;
- an SPDX or CycloneDX software bill of materials;
- vulnerability scan results;
- cryptographic artifact provenance using GitHub artifact attestations where available; and
- checksums and immutable identifiers for every retained artifact.

The OCI image MUST be identified and promoted by digest. It SHOULD be published to GitHub Container
Registry under an immutable commit-SHA tag. A mutable `main` tag MAY point to the newest successful
`main` image, but automation and deployments MUST consume the digest or immutable tag.

Artifact publication requires only package-write, attestation, and identity-token permissions in
the isolated publication job. Test jobs MUST remain read-only. Publication MUST use artifacts built
from the verified commit and MUST NOT rebuild source after approval or between environments.

Until a staging or production target is defined, the pipeline ends at verified artifact publication.
It MUST NOT report an environment deployment. When environments are added, the pipeline MUST promote
the same digest through staging and production, record the environment and digest in GitHub, and run
post-deployment health and functional checks.

## 7. Releases

Releases SHOULD use semantic version tags of the form `vMAJOR.MINOR.PATCH`. A release tag MUST point
to a `main` commit whose full verification and artifact publication succeeded.

The release workflow MUST:

1. verify the tag and referenced commit;
2. locate the existing immutable image and build artifacts for that commit;
3. rerun security policy checks whose data may have changed since the build;
4. attach checksums, SBOM, provenance, and human-readable release notes;
5. add immutable semantic-version tags without replacing the commit-SHA tag; and
6. record any failed promotion without deleting the previously published artifact.

Stable release tags MUST NOT be moved. A broken release receives a new version or is explicitly
yanked; its evidence remains available.

## 8. Dependency and Toolchain Maintenance

The repository MUST configure Dependabot or an equivalent GitHub-integrated updater for npm/pnpm,
GitHub Actions, and Docker ecosystems. It MUST inspect the entire workspace and root lockfile.

Update policy MUST balance currency with reviewability:

- compatible patch and minor updates MAY be grouped by ecosystem on a regular schedule;
- security updates SHOULD open promptly and MUST NOT wait for the ordinary batch when a supported
  fix exists;
- major updates MUST use separate pull requests;
- Node.js LTS, pnpm, `better-sqlite3`, Vite, TypeScript, Fastify, TypeBox, React, TanStack packages,
  Tailwind CSS, Kysely, Pino, Biome, and Playwright updates SHOULD remain individually visible when
  their release notes or compatibility surfaces differ;
- GitHub Action updates MUST retain full-SHA execution pins; and
- container base updates MUST resolve to a reviewed immutable digest.

An update pull request MUST pass the same gates as any other change. Automatic merge MAY be enabled
only for allowlisted patch-level development dependencies after the full required suite passes and
the repository has demonstrated reliable rollback. Runtime, native, security-sensitive, migration,
and major updates require human review.

The lockfile MUST be produced by the pinned pnpm version. CI uses `--frozen-lockfile`; it MUST NOT
repair or refresh dependency metadata during verification. Install scripts SHOULD be disabled by
default or explicitly allowlisted when pnpm and dependency compatibility permit it.

The project MUST review direct dependencies periodically and remove unused packages. A package does
not earn permanent status by appearing in the lockfile.

## 9. Pre-Commit and Local Verification

`make setup` MUST install repository-owned Git hooks after installing the pinned package manager and
dependencies. Hooks SHOULD use Husky and lint-staged, pinned through the root lockfile. Hook behavior
MUST be declared in version-controlled files and MUST NOT depend on a developer's global Git config.

The pre-commit hook MUST remain fast and operate on the staged snapshot. It MUST:

- run Biome formatting and safe lint fixes on supported staged source files;
- run Markdownlint CLI2 on staged documentation;
- reject conflict markers, trailing whitespace, and accidental large generated or binary files;
- run Gitleaks in staged-change or pre-commit mode without uploading content; and
- restage only files selected by lint-staged.

The hook MUST NOT run the complete unit, browser, integration, or container suite. A slow hook trains
contributors to bypass all hooks. It MUST NOT rewrite unrelated unstaged files or stage new files
without the contributor selecting them.

A commit-message hook SHOULD validate the Conventional Commit subset used for squash titles. The
pull-request workflow remains authoritative because local hooks can be bypassed and the final squash
title may differ from local commits.

The repository MAY provide a pre-push hook for `make verify-fast`, consisting of formatting check,
type checking, and the normal unit suite. It MUST remain optional if it materially delays iteration.
`make verify` is required before requesting review and is the canonical local reproduction of CI.

Hooks MAY be bypassed for diagnosis or recovery, but CI requirements do not change. Documentation
MUST describe bypass as an exception, not the ordinary agent workflow. Agent-authored commits are
subject to the same hooks and MUST report any bypass in the pull request.

## 10. Caches, Artifacts, and Retention

CI MAY cache the pnpm content-addressed store using keys derived from the operating system, pinned
Node.js and pnpm versions, and lockfile hash. It MUST NOT cache `node_modules`, built application
output, mutable SQLite databases, credentials, or agent workspaces as trusted inputs.

Cache hits are performance hints, not evidence. A cache miss MUST produce the same result. Protected
publication and deployment jobs MUST NOT restore executable artifacts from an untrusted fork cache.

Failed test artifacts SHOULD be retained for at least 14 days. Release artifacts, SBOMs,
attestations, checksums, and deployment records MUST follow the project release-retention policy and
MUST NOT disappear merely because an Actions run expires.

Artifacts containing issue text, logs, commands, or browser traces MUST be treated as potentially
sensitive. They MUST be redacted, access-controlled by the repository, and assigned the shortest
retention period that still supports diagnosis.

## 11. Failure, Flake, and Rollback Policy

A required check that is canceled, timed out, skipped unexpectedly, or unable to fetch complete
evidence is not successful. Infrastructure failure MAY be rerun; the rerun and original failure MUST
remain visible. Product-test failure MUST be fixed or explicitly reverted, not rerun until green.

A flaky test MUST be recorded as a defect with an owner and bounded repair date. Quarantine requires
an issue, a narrow scope, and a replacement required check that keeps the affected safety property
covered. Silent retries, permanent quarantine, and blanket `continue-on-error` are forbidden for
required behavior.

The repository MUST document rollback for every deployed environment before enabling automatic
deployment. Rollback MUST select a previously verified artifact digest; it MUST NOT rebuild an old
Git revision with a new dependency resolution. Database migrations require a compatible rollback or
forward-repair plan before deployment.

## 12. Required Repository Commands

Once implementation begins, these commands form the stable delivery interface:

```text
make setup          pinned dependencies and repository hooks
make format         apply local formatting
make lint           check formatting, lint, workflow, and documentation policy
make typecheck      TypeScript no-emit check
make test           normal Vitest suite
make test-integration
make test-e2e       Playwright against a production build
make build          server and browser production artifacts
make image          local production container build
make verify-fast    lint, typecheck, and unit tests
make verify         complete non-publishing CI gate
```

Targets MUST fail on the first invalid required result while still preserving available reports.
CI-specific wrappers MAY collect artifacts, but they MUST call these targets rather than maintain a
second definition of correctness.

## 13. Adoption Sequence

CI/CD controls SHOULD land with the code they can validate:

1. documentation, workflow linting, branch rules, and dependency update configuration;
2. pinned Node.js/pnpm toolchain, frozen installation, Biome, and TypeScript checks;
3. Vitest unit/contract suites and coverage floor;
4. SQLite migration and process integration suites;
5. production build and Playwright tests;
6. Docker build, runtime verification, scanning, SBOM, and attestation;
7. immutable `main` artifact publication; and
8. environment promotion only after a real target and rollback contract exist.

A temporarily absent check in this sequence MUST be visible as not yet implemented. Documentation or
an empty passing job MUST NOT imply that an unimplemented safety property has been verified.

## 14. Non-Normative References

- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)
- [GitHub merge queue checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [GitHub dependency review](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub OpenID Connect](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [Dependabot configuration](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
