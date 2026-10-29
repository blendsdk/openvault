# Contributing to OpenVault

Thanks for helping. This project is a security product, so correctness and review quality
matter more than speed.

## Prerequisites

- Node.js 22.23 or newer
- pnpm 12.11.2 (`corepack enable` is the simplest way to match it)
- Docker, for integration tests and the reference stack

## Setup

```bash
git clone https://github.com/blendsdk/openvault.git
cd openvault
pnpm install
pnpm verify
```

`pnpm verify` runs TypeScript 7 typechecking, Biome lint/format checks, unit tests, builds,
and the documentation build. It must pass before a pull request is ready.

Useful commands:

| Command | Purpose |
|---|---|
| `pnpm typecheck` | TypeScript 7 across the workspace |
| `pnpm lint` | Biome check |
| `pnpm format` | Biome check with safe fixes |
| `pnpm test` | Vitest across the workspace |
| `pnpm build` | Build every package |
| `pnpm docs:dev` | VitePress dev server |
| `pnpm docs:build` | Static documentation build |
| `pnpm changeset` | Record a user-visible change |

## Pull requests

1. Open an issue first for a large behavior change or a new dependency.
2. Keep the change focused. One concern per pull request.
3. Add or update tests. Security-relevant behavior needs a test that fails without the fix.
4. Update the documentation page that describes the behavior.
5. Add a Changeset for user-visible changes.
6. Use a Conventional Commit title (`feat:`, `fix:`, `docs:`, `chore:`).

Pull requests must pass CI and receive one approval. `main` is protected.

## Code expectations

- TypeScript strict mode, ESM, Node.js 22.
- Public APIs have documentation comments that explain behavior and edge cases.
- No `any`, no unsafe casts, no string-concatenated SQL.
- No secret values in logs, errors, tests, fixtures, screenshots, or documentation.
- Use `Buffer` for secret material and clear it when practical.
- Keep files focused; split before they become hard to review.
- Match the existing style. Biome is the source of truth for formatting.

## Tests

- `*.spec.test.ts` derives from the documented behavior and is the oracle.
- `*.impl.test.ts` covers internals and may change with refactoring.
- Integration tests use a real PostgreSQL instance and real TLS where the behavior depends
  on it. Mocks are for true externals only.
- Security tests are mandatory for authentication, authorization, audit, crypto, and the
  agent.

## Documentation

The public docs live in `docs/` and are built with VitePress. A behavior change is not done
while its page is stale. Screenshots must use fake projects and sentinel values.

## Security

Never report a vulnerability in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under Apache-2.0.
