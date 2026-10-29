# Contributing

Development setup, test expectations, and pull-request rules are in
[CONTRIBUTING.md](https://github.com/blendsdk/openvault/blob/main/CONTRIBUTING.md).

Quick start:

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs TypeScript 7 typechecking, Biome, tests, builds, and the documentation
build.

## Repository layout

```text
apps/server   WebAFX API
apps/web      React 19 + Fluent UI v9
packages/core domain and envelope encryption
docs/         this site
deploy/       Compose stack and examples
```

## Documentation

A behavior change is not complete while its page is stale. Screenshots must use fake
projects and sentinel values.

## Security

Never report a vulnerability in a public issue. See
[Reporting a vulnerability](/security/reporting).
