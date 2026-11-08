# Testing Strategy: Certificate UI

> **Document**: 07-testing-strategy.md
> **Parent**: [Index](00-index.md)

## Testing Overview

### Coverage goals

| Code type | Target |
|---|---|
| Server list/capability logic | 90% |
| Web pages and dialogs | 80% |
| Generated client and glue | Covered by `api:check` and page tests |
| Documentation guard | 100% of the stated rules |

Test names state behavior: `should [expected behavior] when [condition]`. The web tests render the
real pages and the real generated client through `FakeVault`; they do not mock page modules. The
server tests use the existing PostgreSQL integration harness and real services.

## 🚨 Specification Test Cases

> Derived from RD-01, the component specs, and the Ambiguity Register. The expectations are the
> oracle: a failing spec test means the implementation is wrong, not the test. In-code traceability
> comments quote the behavior in plain language, never an ST/RD/AR id.

### Server: list and capabilities

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-1 | `GET /v1/data/payments/certificates` with no `status` | Only rows whose `deletedAt` is null; deleted rows absent | RD-01 AC-2 |
| ST-2 | `GET .../certificates?status=deleted` | Only rows whose `deletedAt` is not null; no `certificatePem`, `chainPem`, or `privateKeyPem` in the response | RD-01 AC-2, AC-4 |
| ST-3 | `GET .../certificates?q=api` with `api-tls` and `CN=api.payments.internal` | Both match; a row named `billing` with `CN=billing.internal` does not; match is case-insensitive | RD-01 AC-3 |
| ST-4 | `GET .../certificates?q=100%25` | The `%` is treated literally, not as a wildcard | AR-12 |
| ST-5 | `GET .../certificates?status=archived` | 422 `validation_error` | RD-01 AC-2 |
| ST-6 | `GET .../certificates?status=deleted&san=DNS:api&expiresAfter=...` | Returns the intersection; no active or non-matching rows | AR-5, AR-12 |
| ST-7 | Two pages of deleted certificates with `limit=1` and the returned cursor | The second page returns the next deleted row and a null cursor at the end | AR-21 |
| ST-8 | `certificates.reader` lists certificates | `canRead=true`, `canReadPrivate=false`, `canWrite=false`, `canDelete=false`, `canRecover=false`, `canPurge=false` | RD-01 AC-5 |
| ST-9 | `certificates.officer` lists certificates | `canReadPrivate=true`, `canRecover=true`, `canWrite=true`, `canDelete=true`, `canPurge=false` | RD-01 AC-6 |
| ST-10 | `project.admin` lists certificates | `canReadPrivate=true`, `canRecover=true`, `canPurge=true` | AR-14 |
| ST-11 | Run `pnpm api:check` | Exit 0; the browser and CLI clients and OpenAPI document are current | RD-01 AC-25 |

### Web: list and navigation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-12 | Render the list with one active certificate | Name, status, subject, expiry, and tags appear; no PEM or private key appears | RD-01 AC-7 |
| ST-13 | Fill Search, SAN, Expires after, Expires before, Status; Apply filters | The list request sends `q`, `san`, `expiresAfter`, `expiresBefore`, and `status`; the cursor is absent | RD-01 AC-8 |
| ST-14 | Click Load more | The next page request carries the cursor and the applied filters; new rows append | RD-01 AC-8 |
| ST-15 | Select Deleted | Import and Generate are absent; the request sends `status=deleted` | RD-01 AC-9 |
| ST-16 | Active list with no rows, deleted list with no rows, filtered list with no matches | Three distinct empty states with the documented actions | RD-01 AC-9 |
| ST-17 | Navigate to the Certificates section | The section link is current; the launcher lists Certificates; the Docs link targets `/guide/certificates` | RD-01 AC-1 |
| ST-18 | Open a certificate from a deleted-list row | The detail request searches `status=deleted` with `q=<name>` and shows the deleted state | AR-13, PAR-05 |

### Web: detail and public material

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-19 | Open an active certificate | Subject, SANs, issuer, serial, fingerprint, version id, validity, days, chain length, tags, purge fields appear | RD-01 AC-10 |
| ST-20 | Enter a version id and click View public certificate | The read sends `version=<id>` and renders the leaf and chain in text areas | RD-01 AC-11 |
| ST-21 | Copy leaf, Copy chain, Download leaf, Download chain | The copied/downloaded text equals the returned PEM; the chain may be empty | RD-01 AC-11, AC-22 |
| ST-22 | Open an expired certificate and view its current public material | The read includes the current version id and succeeds | RD-01 AC-12 |
| ST-23 | Enter a version id and reveal the private key | The private-key read sends the same `version` value | AR-6, PAR-05 |

### Web: import, generate, renew

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-24 | Fill leaf, chain, key, tags, allow-not-yet-valid; submit import | The request contains the leaf, key, tags, and `allowNotYetValid`; it contains the chain when provided; no separate upload request exists | RD-01 AC-13 |
| ST-25 | Choose a local PEM file for the leaf field | The textarea fills with the file text; the network log has no file upload | RD-01 AC-13 |
| ST-26 | Import succeeds with one warning | The result panel shows the version id and the warning before the dialog closes | RD-01 AC-13 |
| ST-27 | Fill subject, two typed SANs, key type, validity, tags; submit generate | The request contains the same values | RD-01 AC-14 |
| ST-28 | Submit a SAN without a prefix, an empty SAN list, or validity 0/826 | The dialog blocks submission with the matching field error | RD-01 AC-14 |
| ST-29 | Renew from detail | The request includes `expectedVersionId` equal to the current version id | RD-01 AC-15 |
| ST-30 | Renew with a stale expected version | The dialog stays open and shows the version-conflict message | RD-01 AC-15 |

### Web: metadata and lifecycle

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-31 | Edit tags and turn purge protection on | The PATCH contains the new tag map and `purgeProtected=true` | RD-01 AC-16 |
| ST-32 | Open metadata for a protected certificate | The protection switch is on, disabled, and the dialog cannot send `false` | RD-01 AC-16 |
| ST-33 | Delete and confirm | The delete request runs; the detail shows the deleted state with Recover and Purge | RD-01 AC-17 |
| ST-34 | Recover a deleted certificate | The recover request runs and the active state returns | RD-01 AC-18 |
| ST-35 | Purge while active, protected, or before the deadline | The action is disabled with the matching reason and sends no request | RD-01 AC-19 |
| ST-36 | Purge a deleted, unprotected, due certificate and confirm | The purge request runs and the browser returns to the list | RD-01 AC-19 |

### Web: private key

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-37 | Reader or deleted certificate | View private key is absent | RD-01 AC-20 |
| ST-38 | Officer clicks View private key | A confirmation appears; no read happens before confirmation | RD-01 AC-20 |
| ST-39 | Confirm the read | The private-key route is called with the selected version; the key appears in a read-only field | RD-01 AC-20 |
| ST-40 | Wait 60 seconds, blur the region, blur the window, change route, or unmount | The key clears in every case | RD-01 AC-21 |
| ST-41 | Reveal and download the private key | The download filename ends in `.key.pem`; local storage, session storage, IndexedDB, cookies, URL, console, and clipboard contain no key | RD-01 AC-21, AC-22 |

### Web: errors and accessibility

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-42 | Server returns 409 version conflict, 409 purge protection, 409 retention, 403, 404, 422 | The documented message appears; no stack, SQL, or internal path appears | RD-01 AC-23 |
| ST-43 | Run the axe suite on the list and detail | No violations | RD-01 AC-24 |

### Documentation

| # | Input / Scenario | Expected Output / Behavior | Source |
|---|---|---|---|
| ST-44 | Read `docs/guide/web-ui.md` | It lists the certificate list and detail flows and the new capability flags | RD-01 AC-27 |
| ST-45 | Read `docs/security/known-limitations.md` | It no longer says certificate management is CLI-only | RD-01 AC-27 |
| ST-46 | Read the release labels | `README.md`, `docs/index.md`, and `docs/guide/versioning.md` state 1.1.0 | RD-01 AC-27 |
| ST-47 | Run `tests/docs.spec.test.mjs` | The version, implementation-term, and certificate-coverage guards pass | RD-01 AC-26, AC-27 |

## Test Categories

### Specification tests

| Test file | ST cases | Component |
|---|---|---|
| `apps/server/tests/integration/certificate-list.spec.test.ts` | ST-1..ST-7 | List query |
| `apps/server/tests/rbac/certificate-capabilities.spec.test.ts` | ST-8..ST-10 | Capability projection |
| `apps/web/tests/certificates-list.test.tsx` | ST-12..ST-16, ST-18 | List and filters |
| `apps/web/tests/layout.test.tsx` | ST-17 | Launcher, section, and docs link |
| `apps/web/tests/certificate-detail.test.tsx` | ST-19..ST-23 | Detail and public material |
| `apps/web/tests/certificate-import.test.tsx` | ST-24..ST-26 | Import |
| `apps/web/tests/certificate-generate.test.tsx` | ST-27..ST-30 | Generate and renew |
| `apps/web/tests/certificate-lifecycle.test.tsx` | ST-31..ST-36 | Metadata and lifecycle |
| `apps/web/tests/certificate-private-key.test.tsx` | ST-37..ST-41 | Private key |
| `apps/web/tests/certificate-errors.test.tsx` | ST-42 | Error mapping |
| `apps/web/tests/accessibility.test.tsx` | ST-43 | Accessibility |
| `tests/docs.spec.test.mjs` | ST-44..ST-47 | Documentation |
| `apps/server/tests/api-contract.spec.test.ts` or the `api:check` gate | ST-11 | Generated contract |

### Implementation tests

| Test file | Description | Priority |
|---|---|---|
| `apps/web/tests/pem.impl.test.ts` | `readPemFile` size/empty/marker errors and `downloadPem` object-URL cleanup | High |
| `apps/web/tests/certificate-validation.impl.test.ts` | Subject, SAN, validity, and date-boundary helpers | High |
| `apps/server/tests/certificates/repository.impl.test.ts` | LIKE escaping, cursor with status, empty page | High |
| `apps/server/tests/rbac/capability-zero.impl.test.ts` | Inactive principal and missing actor snapshot return all false | Medium |

### Integration tests

| Test | Components | Description |
|---|---|---|
| Certificate list integration | API + service + repository + policy + PostgreSQL | Active/default, deleted, search, filters, cursor |
| Certificate capabilities | API + RBAC + PostgreSQL | Reader/officer/admin flags |
| Generated contract | API contract generator + generated clients | `api:check` |

### End-to-end tests

The project has no browser automation dependency, and the plan does not add one. The manual E2E
check uses the local review stack:

1. Start the review stack with the new web build.
2. Sign in as the administrator.
3. Import a test certificate with a leaf, chain, and key; confirm the warning panel.
4. Generate a self-signed certificate; confirm it appears in the list.
5. Open the detail; view public material; copy and download it.
6. Reveal the private key; confirm the countdown and clear behavior.
7. Edit tags and purge protection; delete; recover; delete again; purge after the test retention.
8. Confirm the audit page records the reads and lifecycle events.

If the local review stack cannot be rebuilt in the execution environment, record the reason and
fall back to the component and integration suites; do not add a harness.

## Test Data

### Fixtures

- Project `payments` with id `01ARZ3NDEKTSV4RRFFQ69G5FAV`.
- Active certificate `api-tls`, subject `CN=api.payments.internal`, SAN
  `DNS:api.payments.internal`, tags `{ env: "prod" }`, version id
  `01ARZ3NDEKTSV4RRFFQ69G5FAX`.
- Expired certificate `old-tls`, notAfter in the past.
- Deleted certificate `retired-tls`, deletedAt and purgeAfter set, purgeProtected false.
- Protected deleted certificate `locked-tls`, purgeProtected true.
- Leaf, chain, and private-key PEM fixtures as short valid PEM strings for display tests; the server
  integration tests use the real certificate fixtures already in the server test helpers.
- Reader, officer, and admin actor fixtures from the existing RBAC helpers.

### Mock requirements

- Web: `FakeVault` is the only adapter mock; it implements the real generated-client paths and
  envelopes.
- Server: the existing PostgreSQL test database harness and real services; no service mocks.
- No mock for the generated client itself.
- `URL.createObjectURL` and `URL.revokeObjectURL` are stubbed in the web test setup only if jsdom
  does not provide them.

## Verification Checklist

- [ ] Every ST case has a concrete input and expected output.
- [ ] Every ST case traces to RD-01, a component spec, or an AR/PAR entry.
- [ ] Specification tests are written before implementation in every phase.
- [ ] The red phase is observed and recorded for every phase.
- [ ] All specification tests pass after implementation.
- [ ] Implementation tests cover the PEM helper, validation, LIKE escaping, and zero capabilities.
- [ ] The integration suite passes on PostgreSQL 16 and 17 in CI.
- [ ] The axe suite passes for the list and detail.
- [ ] `pnpm api:check` passes.
- [ ] `pnpm verify` passes.
- [ ] The manual E2E check is completed or its environment limitation is recorded.
- [ ] No test asserts a private key in storage, the URL, the console, or the clipboard.
