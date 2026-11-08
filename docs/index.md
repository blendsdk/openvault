---
layout: home

hero:
  name: OpenVault
  text: Secrets for Docker Compose
  tagline: Versioned secrets, certificates, access control, and a tamper-evident audit log for projects running in Docker.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tutorials
      link: /tutorials/
    - theme: alt
      text: How it works
      link: /architecture/overview

features:
  - title: Per-service delivery
    details: One agent per Compose service writes secrets to an isolated private directory. The application never talks to the vault.
  - title: Real access control
    details: Deny-by-default roles at organization, project, and object scope.
  - title: Tamper-evident audit
    details: Every read and denial is hash-chained and authenticated. Verify the chain from the CLI or API.
  - title: Runs on Docker Compose
    details: Published images, a hardened reference stack, and a ready-to-run environment-variable example.
---

## Status

OpenVault 1.0 is the first stable release. **Current release: 1.0.1.**

Start with [Getting started](/guide/getting-started), read
[Environment variables](/guide/environment-variables), or review the
[security overview](/security/).
