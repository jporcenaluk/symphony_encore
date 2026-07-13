---
agent:
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
server:
  auth_kind: local
tracker:
  kind: github
  owner: synthetic
  project_number: 1
  repo_owner: synthetic
  repo_name: synthetic
workspace:
  root: /var/lib/symphony/workspaces
  verify_command: make verify
---
# Synthetic work

Complete {{ issue.title }}.
