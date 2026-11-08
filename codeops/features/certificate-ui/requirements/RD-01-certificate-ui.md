# RD-01: Certificate Management UI

> **Document**: RD-01-certificate-ui.md
> **Status**: Draft (preflight ready)
> **Created**: 2026-11-08 16:32
> **Project**: OpenVault
> **Depends On**: openvault-v0-1/RD-09 (Certificates), openvault-v0-1/RD-12 (Web UI)
> **Target Release**: v1.1.0
> **CodeOps Artifact Schema**: 1

## Feature Overview

OpenVault stores, imports, generates, renews, and delivers X.509 certificates, and the API and CLI
already expose that lifecycle. The web UI does not: the project overview shows only a certificate
count, and operators must leave the browser and use `ov cert` for every certificate task.

This requirement adds a first-class **Certificates** section to each project. An operator can list
active or deleted certificates, inspect metadata and public material, import or generate a new
version, read a specific version by id, edit tags and purge protection, reveal or download a private
key after an explicit confirmation, and soft-delete, recover, or purge a certificate. Every action
uses the existing server routes, RBAC policy, and audit trail. The browser never computes effective
permissions and never stores PEM or private keys outside component memory.

The feature is delivered in the v1.1.0 minor release. It adds no certificate authority, ACME
client, public issuance, remote-host support, or new runtime dependency.

## Functional Requirements

### Must Have

- [ ] A project has a **Certificates** section at
  `/projects/:project/certificates`, reachable from the project section navigation and the
  application launcher. [AR-1, AR-2, AR-26]
- [ ] The certificate list shows name, status, subject, expiry, and tags for each row. Status is
  `active`, `expired`, or `deleted` and is rendered as text plus icon. [AR-2, AR-13]
- [ ] The list supports a free-text query, a typed SAN filter, an expiry range, and a status filter.
  The free-text query matches the certificate name or subject, case-insensitively. [AR-12]
- [ ] The list defaults to active certificates and excludes deleted certificates unless the
  operator selects the Deleted view. [AR-5, AR-13]
- [ ] The Deleted view lists only soft-deleted certificates and hides the Import and Generate
  actions. [AR-13]
- [ ] The list uses cursor pagination with a 25-row first page and a Load more action. [AR-21]
- [ ] The certificate detail page at `/projects/:project/certificates/:name` shows name, status,
  subject, SANs, issuer, serial, fingerprint, version id, creation and update times, validity
  window, days to expiry, chain length, tags, purge deadline, and purge protection. [AR-2, AR-15]
- [ ] The detail page supports reading the current version or a version selected by id, and shows
  the public leaf certificate and chain. [AR-6, AR-15]
- [ ] Public leaf and chain material can be copied and downloaded as PEM files. [AR-27]
- [ ] The detail page supports importing a new version, generating a new version, editing tags,
  toggling purge protection, deleting, recovering, and purging, subject to the capability flags. [AR-2, AR-10, AR-19, AR-20]
- [ ] Import accepts a leaf certificate, an optional chain, and a private key as pasted PEM or as
  files read locally in the browser. [AR-8]
- [ ] Generate accepts a subject, one or more typed SANs, a key type, a validity period, and tags. [AR-2]
- [ ] Renewal from the detail page sends the current version id as `expectedVersionId`. Creating a
  certificate from the list warns that an existing name adds a new version. [AR-18]
- [ ] A private key is revealed only after an explicit confirmation, is hidden after 60 seconds or
  when focus leaves the region/window, and can be downloaded as a PEM file. It is never written to
  browser storage, the URL, the console, or application logs. [AR-3, AR-16, AR-27]
- [ ] The UI hides an action when its capability flag is false. The server still authorizes every
  request. [AR-10]
- [ ] All reads, writes, private-key reads, and lifecycle actions produce the existing audit
  events. [AR-11]

### Should Have

- [ ] The project overview certificate count links to the certificate list. [AR-2]
- [ ] Expired certificates show a warning badge and the number of days since expiry. [AR-22]
- [ ] The list shows an empty state for no certificates, no deleted certificates, and no filter
  matches, each with the appropriate next action. [AR-22]
- [ ] An import or generate result shows every server warning before the dialog closes. [AR-17]
- [ ] The top-bar Docs link opens `/guide/certificates` on certificate routes. [AR-26]

### Won't Have (Out of Scope)

- A new certificate authority, ACME client, public issuance, or host trust-store integration. [AR-9]
- Certificate version-history listing. The API has no history route; the UI reads the current
  version or a known version id. [AR-6]
- Bulk import, export, or delete. [AR-9]
- Remote Docker hosts, Kubernetes identity, external KMS/HSM, or multi-region support. [AR-9]
- New locales, a new UI library, a state store, or a new runtime dependency. [AR-9, AR-29]
- Automatic renewal or installation of certificates into application containers. [AR-9]
- Release tagging, release creation, or image publication. The plan ends at release metadata; the
  release workflow remains a separate action. [AR-28]

## Technical Requirements

### Routes and navigation

| Route | Screen | Access |
|---|---|---|
| `/projects/:project/certificates` | Certificate list | Any caller with `certificate.list` |
| `/projects/:project/certificates/:name` | Certificate detail | Any caller with `certificate.read`; deleted items show lifecycle actions only |

The project section list in `apps/web/src/projects/project-route.tsx` gains a **Certificates**
entry between **Secrets** and **Identities**. The launcher in
`apps/web/src/layout/app-shell.tsx` gains the same entry with keywords `certificates`, `tls`, and
`x509`. The router in `apps/web/src/App.tsx` mounts both routes under `ProjectRoute`. The docs
resolver in `apps/web/src/docs.ts` maps the list to `/guide/certificates` and the detail page to
`/guide/certificates#read-and-renew`. [AR-26]

### API contract changes

1. **List status filter.** `certificateListQuerySchema` gains
   `status: z.enum(["active", "deleted"]).default("active")`. The list repository applies
   `deleted_at IS NULL` for `active` and `deleted_at IS NOT NULL` for `deleted`. The response shape
   is unchanged. [AR-5]
2. **Free-text search.** The list query's `q` matches `c.name` or `v.subject` with an
   `ILIKE` pattern, case-insensitively. The existing `%`, `_`, and `\` escaping is retained.
   The SAN and expiry filters are unchanged. [AR-12]
3. **Capability flags.** `capabilityFlagsSchema` gains `canRecover` and `canReadPrivate`. The policy
   projection maps them per resource type:
   - secret: `secret.recover` and `secret.read`
   - certificate: `certificate.recover` and `certificate.read_private`

   The zero-capability fallback returns `false` for both. The list and detail responses include the
   new fields. [AR-7, AR-14]
4. **Browser contract.** `WEB_CONTRACT_CONTROLLERS` in `apps/server/scripts/api-contract.ts` adds
   `CertificatesController` at `/v1/data`, so `pnpm api:generate` produces
   `apps/web/src/generated/client.certificates.ts` and adds the `certificates` group to
   `OpenVaultWebClient`. The browser document remains cookie-authenticated. [AR-24]
5. **No other API route or payload change.** The existing certificate routes keep their paths,
   request fields, response fields, limits, and error codes. [AR-9]

### List behavior

| Control | Behavior |
|---|---|
| Search | Free text; sends `q`; placeholder `Name or subject` |
| SAN | Typed SAN; sends `san`; placeholder `DNS:api.example.com` |
| Expires before | Date input; sends an ISO timestamp at the end of the selected day |
| Expires after | Date input; sends an ISO timestamp at the start of the selected day |
| Status | Select: Active (default) or Deleted; sends `status` |
| Apply filters | Submits the current draft; resets pagination |
| Clear | Restores the default filters and the Active status |

The first page requests `limit=25`. Load more appends the next page and keeps the current filters.
Rows are ordered by the server's name order. The table has a caption, header scope, and a
horizontal scroll at narrow widths. [AR-21, AR-30]

Rows show:

- **Name**: link to the detail page.
- **Status**: `active`, `expired`, or `deleted` badge.
- **Subject**: the subject distinguished name.
- **Expires**: absolute date plus `in N days` or `N days ago`.
- **Tags**: compact `key=value` list, or an em dash.

The page header actions are **Import certificate** (primary) and **Generate** (secondary). Both are
hidden in the Deleted view. [AR-13]

### Detail behavior

The detail page loads metadata from the list route with the current status and `q=<name>`. It picks
the exact name match. If no match exists, it renders a not-found state. [AR-15]

The metadata card shows the fields listed in the Must Have section. The SAN list is rendered as
chips or a comma-separated list. Long values use a monospace font and wrap without horizontal
overflow.

A **Version** control accepts a version ULID. Empty means the current version. The control applies
to public-material reads and private-key reads. [AR-6, AR-15, AR-16]

Public material is loaded only after **View public certificate** is activated. The panel shows the
leaf PEM and the chain PEM in read-only text areas, with **Copy leaf**, **Copy chain**,
**Download leaf**, and **Download chain**. The read sends the selected version id, so an expired
current certificate remains inspectable without changing the server's current-version expiry
behavior. [AR-15, AR-27]

The action bar is capability-driven:

| Action | Visible when | Notes |
|---|---|---|
| Edit metadata | `capabilities.canWrite` and the certificate is active or expired | Tags and purge protection |
| Import new version | `capabilities.canWrite` and the certificate is active or expired | Sends `expectedVersionId` |
| Generate new version | `capabilities.canWrite` and the certificate is active or expired | Sends `expectedVersionId` |
| View private key | `capabilities.canReadPrivate` and not deleted | Explicit confirmation |
| Delete | `capabilities.canDelete` and the certificate is active or expired | Soft delete |
| Recover | `capabilities.canRecover` and the certificate is deleted | Immediate |
| Purge | `capabilities.canPurge` and the certificate is deleted | Gated by protection and retention |

[AR-10, AR-14, AR-19, AR-20]

### Import

The import dialog contains:

| Field | Required | Validation |
|---|---|---|
| Name | Yes | Same allowlist as a secret name; 1–127 characters; starts alphanumeric; letters, digits, and hyphens |
| Leaf certificate PEM | Yes | Exactly one `CERTIFICATE` block; at most 256 KiB |
| Chain PEM | No | Zero or more `CERTIFICATE` blocks; at most 256 KiB |
| Private key PEM | Yes | Exactly one `PRIVATE KEY` block; at most 64 KiB |
| Tags | No | `key=value` lines; same bounds as secret tags |
| Allow not-yet-valid | No | Checkbox mapped to `allowNotYetValid` |

Each PEM field has a **Choose file** control that reads the selected file in the browser and fills
the textarea. No file is uploaded to a separate endpoint. [AR-8, AR-23]

The dialog sends `certificateImportRequestSchema` fields to
`client.certificates.importCertificate`. In renew mode the name is fixed and
`expectedVersionId` is set. On success, the dialog shows the returned version id and every warning,
with **Open certificate** and **Close**. [AR-17, AR-18]

### Generate

The generate dialog contains:

| Field | Required | Validation |
|---|---|---|
| Name | Yes | Same as import |
| Subject | Yes | RFC 4514 distinguished name; contains `=`; at most 1,024 characters |
| SANs | Yes | One typed SAN per line; 1–100 entries; each at most 2,048 characters; prefix `DNS:`, `IP:`, `URI:`, or `email:` |
| Key type | Yes | `ec-p256` (default), `rsa-2048`, or `rsa-3072` |
| Validity days | Yes | Integer 1–825; default 365 |
| Tags | No | Same as import |

The dialog sends `certificateGenerateRequestSchema` fields to
`client.certificates.generateCertificate`. In renew mode the name is fixed and
`expectedVersionId` is set. The success panel matches import. [AR-2, AR-18, AR-23]

### Metadata

The metadata dialog edits tags and purge protection with
`certificateMetadataUpdateRequestSchema`:

- Tags replace the current map; an empty list removes all tags.
- The purge-protection switch can be turned on. When it is already on, the switch is disabled and
  the dialog explains that it cannot be turned off.
- At least one field must change before the dialog submits. [AR-19]

### Delete, recover, and purge

- **Delete** opens a danger confirmation naming the certificate and the recovery window. On
  success, the detail page shows the deleted state in place.
- **Recover** calls the recover route and reloads the metadata. No confirmation is required.
- **Purge** opens a danger confirmation. The action is disabled with a visible reason when the
  certificate is not deleted, `purgeProtected` is true, or `purgeAfter` is in the future. After a
  successful purge, the browser navigates to the list. [AR-20]

### Private key

The **View private key** action is shown only when `capabilities.canReadPrivate` is true and the
certificate is not deleted. Activating it opens a danger confirmation that states the read is
audited and the key hides after 60 seconds. On confirmation, the page calls
`getCertificatePrivateKey` with the selected version id and shows:

- a read-only text area with the PEM key,
- a countdown from 60 seconds,
- a **Download private key** button.

The key clears when the countdown reaches zero, the region loses focus, the window loses focus, the
route changes, or the component unmounts. It is never copied to the clipboard automatically and is
never written to storage, the URL, the console, or logs. [AR-3, AR-16, AR-27]

### Error handling

| Condition | User-facing handling |
|---|---|
| `certificate_version_conflict` (409) | “This certificate changed. Reload the page and try again.” |
| `purge_protection_locked` (409) | “Purge protection is on and cannot be turned off.” |
| `certificate_retention_active` (409) | “The retention period has not ended. Purge is available after the displayed date.” |
| `certificate_not_found` (404) | The not-found state with a link back to the list |
| `access_denied` or a hidden action (403) | “You do not have permission for this action.” |
| `validation_error` (422) | The form stays open; field-level messages appear where known, otherwise a generic validation error |
| Any network or unknown failure | `ErrorAlert` with the server message and a retry action; no raw stack or internal path |

[AR-22]

## Integration Points

### With openvault-v0-1/RD-09 (Certificates)

The server already owns certificate validation, encryption, versions, expiry, warnings, lifecycle,
and audit. This feature consumes those routes; it does not reimplement cryptography, parsing, or
storage. The only server changes are the list filter, the search predicate, and the capability
projection.

### With openvault-v0-1/RD-12 (Web UI)

The feature follows the existing project shell, section navigation, filter bar, table, dialogs,
capability gating, async panels, and accessibility patterns. The generated browser client is the
only transport.

### With the documentation set

`docs/guide/web-ui.md` gains the certificate daily flows and capability names;
`docs/guide/certificates.md` gains a Web UI section; `docs/security/known-limitations.md` stops
saying certificate management is CLI-only; `docs/changelog.md` records 1.1.0; `docs/reference/api.md`
records the list status filter and the new capability flags. [AR-28]

## Scope Decisions

| Decision | Options Considered | Chosen | Rationale | AR Ref |
|----------|-------------------|--------|-----------|--------|
| Feature location | New feature set, extend v1.0, standalone | New `certificate-ui` feature set, RD-01 | Keeps the closed v1.0 set intact; nested ids reset per feature | AR-1 |
| Lifecycle coverage | Full parity, read/create, read-only | Full parity | Closes the operator gap in one coherent feature | AR-2 |
| Private key | Include with confirmation, CLI-only | Include with confirmation | The API, RBAC, rate limit, and audit already exist | AR-3 |
| Release | v1.1.0, v1.0.2, undecided | v1.1.0 | New user-facing capability belongs in a minor release | AR-4 |
| Deleted visibility | Status filter, recover by name, omit lifecycle | Status filter | Makes recover/purge reachable without guessing names | AR-5 |
| Version access | Current + id, current only, history endpoint | Current + id | Matches `ov cert get --version-id` without new API | AR-6 |
| Private-key gating | Add capability, reuse `canWrite`, always show | Add capability | Precise and safe for future roles | AR-7 |
| PEM input | Paste + file picker, paste only, files only | Paste + file picker | Works for both copy-paste and file-based operators | AR-8 |
| Search | Name or subject, subject only, new name parameter | Name or subject | Operators know names; subject search remains | AR-12 |
| Capability placement | Shared flags, certificate-only, proxy | Shared flags with `canRecover` and `canReadPrivate` | One concept, both resource types, additive contract | AR-14 |
| Detail data flow | List metadata + explicit read, read on load, new endpoint | List metadata + explicit read | Avoids audit noise and a new endpoint | AR-15 |
| Private-key reveal | Timer + blur, persistent, clipboard | Timer + blur, download only | Minimizes browser exposure | AR-16 |
| Import result | Result panel, toast, navigate away | Result panel | No notification infrastructure; warnings stay visible | AR-17 |
| Renew guard | Expected version, no guard, always block | Expected version | Prevents stale overwrite without breaking create-or-renew | AR-18 |
| Metadata | Combined dialog, separate, tags only | Combined dialog | One endpoint, one screen | AR-19 |
| Purge UX | Gated, optimistic, hide | Gated with reasons | Destructive action needs clear preconditions | AR-20 |
| Test strategy | Spec-first, implementation-first, manual | Spec-first | Project standard and regression safety | AR-25 |
| Complexity | Reuse stack, new UI library, new store | Reuse stack | No material support surface is needed | AR-29 |

> **Traceability:** Every decision references the Ambiguity Register entry that resolved it. See
> `00-ambiguity-register.md`.

## Security Considerations

- **Data sensitivity**: Private keys and certificate PEM material are sensitive. Public
  certificates and chains are not secret, but every read is still audited. Tags and subjects may
  contain operational metadata; they are rendered as text, never as HTML. [AR-11]
- **Input validation**: The client validates names, tags, subjects, SANs, validity, PEM block
  counts, and file sizes for fast feedback. The server remains authoritative and applies its
  existing cryptographic and schema validation. [AR-23]
- **Authentication and authorization**: Every route uses the existing authenticated browser
  session and CSRF protection. The UI hides actions from capability flags, but the server checks
  `certificate.*` actions on every request. `certificates.reader` cannot write, delete, recover,
  purge, or read private keys. [AR-10, AR-14]
- **Injection risks**: React escapes all text. PEM is rendered in text areas and `<code>` elements,
  not HTML. The client does not evaluate PEM or tags. No shell or SQL is built in the browser.
  Server-side list filters remain parameterized and escape LIKE metacharacters. [AR-12, AR-23]
- **Encryption**: The server encrypts private keys at rest and uses TLS in transit; the UI adds no
  storage or transport. [AR-11]
- **Rate limiting**: The existing certificate list, write, and private-key rate limits apply. The
  UI does not add a bypass or a retry storm; failed requests show an error and wait for the
  operator. [AR-11]
- **Infrastructure**: No container, network, secret, or deployment change. No new dependency. [AR-9, AR-29]
- **Destructive actions**: Delete is soft; purge is gated by deleted state, purge protection,
  retention, and a danger confirmation. Recover is explicit. [AR-20]
- **Browser storage**: No PEM, private key, or session material in local storage, session storage,
  IndexedDB, JavaScript-readable cookies, or the URL. The only existing local-storage key remains
  the theme preference. [AR-11]

## Non-Functional Requirements

### Accessibility

- Every field has a programmatic label and an associated error message.
- Dialogs trap focus, restore focus to the trigger, and close with Escape.
- The list table has a caption and column headers with scope.
- Status uses text and an icon, not color alone.
- The list and detail pages pass the existing axe checks.
- The table scrolls horizontally at 768 px without hiding the name or status columns. [AR-30]

### Performance

- The first list page requests at most 25 rows; Load more is explicit.
- Capabilities are computed once per page, not per row.
- Public material and private keys are fetched only on an explicit action.
- No polling and no background refresh beyond the operator's actions. [AR-21]

### Compatibility

- The feature works in the same browsers as the existing web UI.
- The API changes are additive: existing clients see the old list behavior by default and ignore the
  new capability flags.
- No database migration is required. [AR-14, AR-24]

## Acceptance Criteria

1. [ ] Navigating to `/projects/payments/certificates` shows a table with the active certificates
   for that project, and the project shell marks **Certificates** as the current section.
2. [ ] With no `status` query, the API returns only certificates whose `deletedAt` is null. With
   `status=deleted`, it returns only certificates whose `deletedAt` is not null.
3. [ ] `GET /v1/data/payments/certificates?q=api` returns a certificate named `api-tls` and a
   certificate whose subject contains `api`, and excludes a certificate whose name and subject do
   not contain `api`. The match is case-insensitive.
4. [ ] `GET /v1/data/payments/certificates?status=deleted&q=tls` returns deleted certificates only;
   the response contains metadata but no `certificatePem`, `chainPem`, or `privateKeyPem`.
5. [ ] A `certificates.reader` sees `canRead=true`, `canReadPrivate=false`, `canWrite=false`,
   `canDelete=false`, `canRecover=false`, and `canPurge=false` on certificate metadata.
6. [ ] A `certificates.officer` sees `canReadPrivate=true`, `canWrite=true`, `canDelete=true`, and
   `canRecover=true`, and `canPurge=false`.
7. [ ] The certificate list renders name, status, subject, expiry, and tags without rendering any
   PEM or private key.
8. [ ] Applying a search, SAN, expiry, or status filter sends the matching query parameter and
   resets the cursor; Load more appends the next page and preserves the filters.
9. [ ] The Deleted view hides Import and Generate and shows only deleted certificates. Its empty
   state is distinct from the active empty state.
10. [ ] The detail page shows the metadata fields in the Must Have list, including the SANs,
    fingerprint, version id, and purge deadline.
11. [ ] **View public certificate** sends a read with the selected version id and renders the leaf
    and chain in text areas. **Copy leaf** and **Download leaf** produce the same PEM text.
12. [ ] An expired certificate's detail page can display its current public material because the
    read includes the current version id.
13. [ ] Import sends the leaf, key, tags, and `allowNotYetValid`; it sends the chain when one is
    provided. A file chosen through **Choose file** fills the matching textarea without a network
    upload.
14. [ ] Generate sends the subject, SANs, key type, validity days, and tags. A SAN without a typed
    prefix, an empty SAN list, or a validity outside 1–825 blocks submission with a field error.
15. [ ] Renewing from the detail page sends `expectedVersionId` equal to the current version id. A
    stale value surfaces the version-conflict message and leaves the dialog open.
16. [ ] The metadata dialog sends the new tag map and `purgeProtected=true` when protection is turned
    on. The switch is disabled and cannot send `purgeProtected=false` when protection is already on.
17. [ ] Delete asks for confirmation, then shows the deleted state with Recover and Purge actions.
18. [ ] Recover restores the active state without a confirmation.
19. [ ] Purge is disabled with a visible reason when the certificate is active, protected, or before
    `purgeAfter`; when enabled, it asks for confirmation and navigates to the list on success.
20. [ ] **View private key** is hidden when `canReadPrivate` is false and when the certificate is
    deleted. When allowed, it asks for confirmation, calls the private-key route with the selected
    version id, and shows the key.
21. [ ] The revealed private key clears after 60 seconds, on region blur, on window blur, on route
    change, and on unmount. It never appears in local storage, session storage, IndexedDB, cookies,
    the URL, the console, or logs.
22. [ ] **Download private key** saves a PEM file; **Download leaf** and **Download chain** save
    their respective PEM files.
23. [ ] A `403`, `404`, `409`, or `422` response renders the specified message and never a raw stack,
    SQL fragment, or internal path.
24. [ ] The list and detail screens have no axe violations in the existing accessibility suite.
25. [ ] `pnpm api:check` reports no generated-client or OpenAPI drift.
26. [ ] `pnpm verify` passes, including the documentation guard.
27. [ ] The published documentation describes the certificate UI, no longer states that certificate
    management is CLI-only, and states the 1.1.0 release.
