# Changelog

## 0.1.0 — in development

### Added

- pnpm 12 workspace with TypeScript 7.0.2 and Biome 2.6.4.
- Envelope-encryption core with per-version data keys, AAD binding, and tests.
- WebAFX server skeleton with `GET /v1/ready` and `GET /health`.
- React 19 + Fluent UI v9 web shell using `@blendsdk/fluentui-react-components` and
  `blendsdk/react`.
- VitePress documentation site with GitHub Pages deployment.
- CI, CodeQL, dependency review, and secret-scan workflows.

### Planned

- Local and OIDC BFF authentication.
- Secrets and certificates.
- Scoped RBAC and per-object capabilities.
- Per-service agent with mTLS and tmpfs delivery.
- CLI and Docker Compose scaffold.
- Audit chain, verification, and export.
- Minimal web UI.
