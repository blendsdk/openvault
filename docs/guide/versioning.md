# Versioning and compatibility

OpenVault follows [Semantic Versioning](https://semver.org/). Version 1.0.0 is the first
stable release.

## What the v1 promise covers

| Surface | Promise |
|---|---|
| `/v1` API | Existing paths, request bodies, response shapes, and documented error codes stay compatible within 1.x |
| Additions | New optional fields and endpoints may appear in minor releases |
| Breaking changes | Require a new major version (`/v2`) or a documented deprecation period |
| Database | Migrations are forward-only. Back up before upgrading; restore supports the current major backup format |
| Deprecations | Announced in the changelog and kept for at least one minor release where practical |
| Security fixes | Applied to the latest 1.x release; `main` receives fixes first |

Clients should ignore unknown response fields. Operators should read the changelog before
upgrading and keep an encrypted backup from before the upgrade.

## Pre-release builds

Pre-release tags and images are for testing. They are labelled not for production and do not
carry the v1 compatibility promise.

## Asking for a change

A compatibility concern is a security and operations issue. Open an issue with the affected
version, the request or response, and the migration you need.
