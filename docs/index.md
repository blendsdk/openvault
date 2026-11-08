---
layout: home

hero:
  name: OpenVault
  text: Secrets for Docker Compose
  tagline: Versioned secrets, certificates, RBAC, and a tamper-evident audit log for projects running in Docker.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tutorials
      link: /tutorials/
    - theme: alt
      text: Architecture
      link: /architecture/overview

features:
  - title: Per-service delivery
    details: One agent per Compose service writes secrets to an isolated tmpfs directory. The application never talks to the vault.
  - title: Real access control
    details: Deny-by-default roles at organization, project, and object scope, with per-object capabilities for the UI.
  - title: Tamper-evident audit
    details: Every read and denial is hash-chained and HMAC-protected. Verify the chain from the CLI or API.
  - title: Runs on Docker Compose
    details: Published images, a hardened reference stack, and a ready-to-run environment-variable example.
---

## Status

OpenVault 1.0 is the first stable release. **Current release: 1.0.1.** The OpenAI Codex
Security scan is a manual, periodic check; it is not part of CI/CD and does not block a
release. Pre-release images are explicitly not for production.

See [Getting started](/guide/getting-started) for the installation flow,
[Environment variables](/guide/environment-variables) for the loader pattern, or the
[security evidence matrix](/security/evidence-matrix) for the test-to-control mapping.
