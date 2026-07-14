# Development and Git hooks

Run `make setup` from a clone to install the frozen pnpm graph, the repository-owned hooks, and the
pinned Gitleaks binary. The installer supports Linux and macOS on x64 and arm64, downloads Gitleaks
8.30.1 from its immutable release URL, and verifies the platform archive SHA-256 before installing
it beneath the ignored `.tools` directory.

The pre-commit hook operates on the staged snapshot:

- lint-staged runs Biome safe fixes on selected staged source files and Markdownlint CLI2 on selected
  staged Markdown;
- the staged policy rejects whitespace errors, conflict markers, binary additions, and blobs larger
  than 1 MiB; and
- Gitleaks scans staged Git content with redacted output.

Lint-staged restages only files already selected for the commit. The hook does not run unit,
integration, browser, or container suites. The commit-message hook enforces the Conventional Commit
subject accepted by pull-request CI.

Use `git commit --no-verify` only for diagnosis or repository recovery. Record the bypass and its
reason in the pull request, then run the omitted checks directly before requesting review. Hook
bypass never changes the CI requirements.

`make verify-fast` remains the optional pre-push check; the repository does not install a slow
pre-push hook. Run `make verify` before requesting review.
