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
      text: Architecture
      link: /architecture/overview

features:
  - title: Per-service delivery
    details: One agent per Compose service writes secrets to an isolated tmpfs directory. The application never talks to the vault.
  - title: Real access control
    details: Deny-by-default roles at organization, project, and object scope, with per-object capabilities for the UI.
  - title: Tamper-evident audit
    details: Every read and denial is hash-chained and HMAC-protected. Verify the chain from the CLI or API.
  - title: Built on BlendSDK v5
    details: WebAFX, PostgreSQL, typed API generation, and a React 19 + Fluent UI v9 front end.
---

## Status

OpenVault is in early development. The repository currently contains the workspace,
envelope-encryption core, WebAFX server skeleton, web shell, and this documentation site.
Secrets, certificates, RBAC, the agent, and the full UI are being implemented.

See [Getting started](/guide/getting-started) for the developer preview and the target v0.1
installation flow.
