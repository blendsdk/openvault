# Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-01 | Own REST API, Azure-inspired | Clean UX and object model; compatibility is a tax with no v0.1 user |
| AD-02 | BlendSDK v5 web stack | WebAFX, PostgreSQL, auth, codegen, and React integration are maintained |
| AD-03 | PostgreSQL, no ORM | Control over transactions, audit ordering, and parameterized SQL |
| AD-04 | Envelope encryption with a file-based KEK | Works offline; KMS can replace the provider later |
| AD-05 | mTLS and join tokens for workloads | No static API keys; short-lived credentials |
| AD-06 | One agent per Compose service | Least privilege and per-service tmpfs isolation |
| AD-07 | Files over environment by default | Environment leaks through `/proc`, children, and crash dumps |
| AD-08 | Unified BFF session for local and OIDC | One session model, no tokens in JavaScript, local users can use the UI |
| AD-09 | Memory sessions in v0.1 | No Redis service and no token at rest; users re-login after restart |
| AD-10 | Allow-only RBAC, default deny | Simple to reason about and test |
| AD-11 | Custom scoped policy over `blendsdk/authz` | `authz` has no org/project/object scopes |
| AD-12 | Synchronous audit, fail closed | A read without an audit record is a security defect |
| AD-13 | TypeScript 7 and Biome | Latest compiler; Biome avoids the typescript-eslint gap |
| AD-14 | Single node, same host | Matches the target operator; avoids premature HA |
| AD-15 | Shared host tmpfs per project and service | Practical shared memory in Compose |
| AD-16 | VitePress docs on GitHub Pages | Reproducible setup and a discoverable product |

## TypeScript 7

BlendSDK 5.67 and the Fluent UI components package are compiled with TypeScript 7.0.2 in
this repository. The P0 compile check is the gate: if a future dependency update breaks the
native compiler, the build fails before merge.

`typescript-eslint` does not support TypeScript 7, so Biome handles lint and format and
`tsc --noEmit` handles type correctness.
