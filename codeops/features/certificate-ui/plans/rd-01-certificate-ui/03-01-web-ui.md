# Web UI: Certificate UI

> **Document**: 03-01-web-ui.md
> **Parent**: [Index](00-index.md)

## Overview

This specification owns the browser surface: routes, navigation, pages, dialogs, state, validation,
private-key handling, and accessibility. It consumes the generated client from
`03-02-server-contract.md` and the behaviors in RD-01. The implementation reuses the existing
project shell, filter bar, table, dialog, feedback, and reveal patterns.

## Architecture

### Current architecture

- `App.tsx` mounts project pages under `ProjectRoute`.
- `ProjectRoute` renders the project header, a section nav, and the child route.
- `app-shell.tsx` renders the launcher entries for the current project.
- `docs.ts` maps a route to the published guide.
- Pages use local state and `useAsync`; mutations call the generated client and reload.
- The secret detail page owns the audited reveal lifecycle and the capability-gated action bar.

### Proposed changes

```text
App.tsx
  projects/:project
    ├── certificates                 CertificatesPage
    └── certificates/:name           CertificateDetailPage

project-route.tsx  → SECTIONS gains Certificates
app-shell.tsx      → launcher gains Certificates
docs.ts            → /guide/certificates (+ #read-and-renew)
```

New files:

| File | Responsibility |
|---|---|
| `apps/web/src/pages/certificates-page.tsx` | List, filters, pagination, page-level actions |
| `apps/web/src/pages/certificate-detail-page.tsx` | Metadata, public material, version read, lifecycle, private key |
| `apps/web/src/components/certificate-import-dialog.tsx` | Import form, local PEM files, result/warnings |
| `apps/web/src/components/certificate-generate-dialog.tsx` | Generate form, SANs, result/warnings |
| `apps/web/src/components/certificate-metadata-dialog.tsx` | Tags and purge protection |
| `apps/web/src/components/pem.ts` | `readPemFile`, `downloadPem` helpers |
| `apps/web/src/components/certificate-status.tsx` (optional) | Shared expiry/status rendering if the page needs a helper |

## Implementation Details

### Routes and navigation

```tsx
// App.tsx
<Route path="certificates" element={<CertificatesPage />} />
<Route path="certificates/:name" element={<CertificateDetailPage />} />
```

`ProjectRoute` adds:

```ts
{ suffix: "/certificates", label: "Certificates", end: false }
```

between `Secrets` and `Identities`. `app-shell.tsx` adds a launcher item with a certificate icon
(`Certificate20Regular` or the closest existing Fluent icon), keywords `certificates tls x509`, and
the same path. `docs.ts` adds:

```ts
case "certificates":
  return segments.length > 3
    ? "/guide/certificates#read-and-renew"
    : "/guide/certificates";
```

[AR-26, PAR-04]

### `CertificatesPage`

**State**

```ts
interface Filters {
  q: string;
  san: string;
  expiresBefore: string; // date input
  expiresAfter: string;  // date input
  status: "active" | "deleted";
}
```

The page holds `draft` and applied `filters`, `extra` rows, `nextCursor`, `moreLoading`, and
`moreError`, mirroring `secrets-page.tsx`. [PAR-07]

**Query**

```ts
await client.certificates.listCertificates({
  project: project.name,
  limit: 25,
  status: filters.status,
  ...(filters.q ? { q: filters.q } : {}),
  ...(filters.san ? { san: filters.san } : {}),
  ...(filters.expiresAfter ? { expiresAfter: startOfDayIso(filters.expiresAfter) } : {}),
  ...(filters.expiresBefore ? { expiresBefore: endOfDayIso(filters.expiresBefore) } : {}),
});
```

`startOfDayIso` and `endOfDayIso` convert a `YYYY-MM-DD` input to an ISO timestamp in the local
timezone, so the visible date and the query agree. They live in `validation.ts` or a small local
helper.

**Table**

| Column | Render |
|---|---|
| Name | `<Link>` to the detail route |
| Status | `<StatusBadge status={certificate.status} />` |
| Subject | text, wrapping |
| Expires | `formatTime(notAfter)` plus `in N days` / `N days ago` from `daysToExpiry` |
| Tags | `formatTags(tags)` |

`caption="Certificates"`, `busy={page.loading || moreLoading}`, and a Load more button when
`nextCursor !== null`. [AR-21, AR-30]

**Header actions**

- **Import certificate** (primary) opens `CertificateImportDialog` with `mode="create"`.
- **Generate** (secondary) opens `CertificateGenerateDialog` with `mode="create"`.
- Both are hidden when `filters.status === "deleted"`. [AR-13]

**Empty states**

| Condition | Title | Action |
|---|---|---|
| Active, no rows, no filters | No certificates yet | Import certificate / Generate |
| Active, no rows, filters | No certificates match | Clear filters |
| Deleted, no rows | No deleted certificates | Back to active (sets status) |

**Errors**

`AsyncPanel` renders the page load error with retry. Mutation errors from the dialogs are local to
the dialog. [AR-22]

### `CertificateDetailPage`

**Metadata load**

```ts
const page = await client.certificates.listCertificates({
  project: project.name,
  status: "active", // or "deleted" when the route is opened from a deleted link
  q: name,
  limit: 100,
});
const certificate = page.certificates.find((item) => item.name === name);
```

The page needs to know whether to search active or deleted. The list link includes
`?status=deleted`; the detail route reads `useSearchParams()` and defaults to `active`. The list's
row link uses `${base}/${name}?status=${filters.status}`. This keeps deleted detail links
shareable and avoids an extra API. [AR-13, PAR-05]

**Header**

Breadcrumb `Certificates / <name>`, title with the name, status badge, and the capability-gated
action buttons. The action bar is a compact wrap row; destructive actions use `appearance="subtle"`
or a menu if the row overflows. [AR-10]

**Metadata card**

Use `DescriptionList` / `DescriptionListItem` where the layout fits, and a definition grid for the
long fields:

- Subject, issuer, serial, fingerprint (monospace, wrap), version id (monospace), SANs (list),
  not-before, not-after, days to expiry, chain length, tags, created, updated, deleted-at,
  purge-after, purge-protected.
- For deleted items, show the purge deadline and a note that public material is unavailable.

**Version control**

A labeled `Input` for a version ULID and a **Load version** button. Empty means current. Store the
selected version id in state; reset it to the current version when the metadata reloads. Use the
same value for public and private reads. [AR-6, PAR-05]

**Public material**

A `Card` with **View public certificate**. On click:

```ts
const response = await client.certificates.getCertificate({
  project: project.name,
  name,
  ...(version ? { version } : {}),
});
```

Show two read-only text areas (leaf, chain), copy buttons for public material, and download
buttons. If `chainPem` is empty, show “No intermediate chain”. If the request fails, show
`ErrorAlert` and keep the metadata. [AR-15, AR-27]

**Private key**

Show **View private key** only when `certificate.capabilities.canReadPrivate && certificate.status !== "deleted"`.
On click, open a danger confirmation:

```text
Reveal the private key for <name>?
This read is audited. The key is hidden after 60 seconds and is never copied automatically.
```

On confirm:

```ts
const response = await client.certificates.getCertificatePrivateKey({
  project: project.name,
  name,
  ...(version ? { version } : {}),
});
```

Render a read-only text area, a countdown, and **Download private key**. Clear on timer, region
blur, window blur, route change, and unmount. Use a `useEffect` cleanup for the timer and listeners,
mirroring `secret-detail-page.tsx`. [AR-3, AR-16, PAR-09]

**Action handlers**

| Action | Call | Result |
|---|---|---|
| Edit metadata (active or expired only) | `updateCertificateMetadata` | Reload metadata |
| Import new version | `importCertificate` with `expectedVersionId` | Result panel; reload |
| Generate new version | `generateCertificate` with `expectedVersionId` | Result panel; reload |
| Delete | `deleteCertificate` after confirm | Show deleted state in place; clear public/private material |
| Recover | `recoverCertificate` | Reload metadata; return to active state |
| Purge | `purgeCertificate` after confirm | Navigate to list |

Purge eligibility:

```ts
const purgeReady =
  certificate.status === "deleted" &&
  !certificate.purgeProtected &&
  certificate.purgeAfter !== null &&
  Date.parse(certificate.purgeAfter) <= Date.now();
```

When not ready, disable the button and show one reason: active certificate, purge protection, or
the retention date. [AR-20]

### `CertificateImportDialog`

Props:

```ts
interface CertificateImportDialogProps {
  readonly open: boolean;
  readonly project: string;
  readonly renew?: { readonly name: string; readonly versionId: string };
  readonly onClose: () => void;
  readonly onSaved: () => void;
}
```

Fields and validation are in RD-01 §Import. Use `react-hook-form` with `FormTextField` /
`FormTextareaField` where they fit. Tags use `parseTagLines`. Each PEM field has a hidden file input
and a **Choose file** button; `readPemFile(file, maxBytes)` fills the field. [PAR-08]

Submit:

```ts
await client.certificates.importCertificate({
  project,
  name,
  certificatePem,
  ...(chainPem ? { chainPem } : {}),
  privateKeyPem,
  tags,
  allowNotYetValid,
  ...(renew ? { expectedVersionId: renew.versionId } : {}),
});
```

On success, show the result panel with `version.id`, `warnings`, **Open certificate**, and
**Close**. `onSaved` reloads the list. [AR-17, AR-18]

### `CertificateGenerateDialog`

Props match the import dialog. Fields and validation are in RD-01 §Generate. SANs are a textarea
with one entry per line; parse, trim, drop blanks, and validate the typed prefix before submitting.
The key type is a Fluent `Dropdown` with three options. Validity is a number input. [AR-23]

Submit:

```ts
await client.certificates.generateCertificate({
  project,
  name,
  subject,
  sans,
  keyType,
  validityDays,
  tags,
  ...(renew ? { expectedVersionId: renew.versionId } : {}),
});
```

Success and warnings match import. [AR-17]

### `CertificateMetadataDialog`

Props: `open`, `project`, `certificate`, `onClose`, `onSaved`.

Fields:

- Tags textarea, prefilled with `key=value` lines.
- Purge protection `Switch`. If `certificate.purgeProtected` is true, the switch is on and
  disabled, with the note “Purge protection cannot be turned off.”
- Submit is disabled until at least one field differs from the current value.

Submit:

```ts
await client.certificates.updateCertificateMetadata({
  project,
  name: certificate.name,
  tags,
  ...(purgeProtectionChanged ? { purgeProtected: next } : {}),
});
```

[AR-19]

### PEM helpers

`apps/web/src/components/pem.ts`:

```ts
/** Reads a local PEM file and rejects files above the limit. */
export function readPemFile(file: File, maxBytes: number): Promise<string>;

/** Downloads text as a file without persisting it in browser storage. */
export function downloadPem(filename: string, text: string): void;
```

`readPemFile` uses `FileReader` and rejects empty files, files over the limit, and files without a
`-----BEGIN ` marker. `downloadPem` creates a Blob, an object URL, a temporary anchor, clicks it,
and revokes the URL. It never writes to storage. [PAR-08, PAR-09, AR-27]

### Client validation

Add to `apps/web/src/validation.ts`:

```ts
export function validateCertificateName(value: string): string | undefined;
export function parseSubject(value: string): string | undefined;
export function parseSans(value: string): { readonly sans: string[]; readonly error?: string };
export function parseValidityDays(value: string): { readonly days: number; readonly error?: string };
export function startOfDayIso(value: string): string;
export function endOfDayIso(value: string): string;
```

`validateCertificateName` delegates to the existing secret-name validator because the server uses
the same schema. The SAN parser enforces the typed prefix, non-empty value, 1–100 entries, 2,048
characters per entry, and no control characters. The subject parser requires `=` and at most 1,024
characters. The validity parser enforces an integer 1–825. The server remains authoritative. [AR-23]

### Error handling

| Error case | Handling | Ref |
|---|---|---|
| Version conflict on renew | Inline dialog message; keep values; do not close | AR-18, PAR-10 |
| Purge protection locked | Disable the switch; explain; no request | AR-19, PAR-10 |
| Retention active | Disable purge; show the deadline | AR-20, PAR-10 |
| Not found | Not-found state with a back link | AR-22, PAR-10 |
| Access denied | “You do not have permission for this action.” | AR-10, PAR-10 |
| Validation | Field errors where known; generic form error otherwise | AR-23, PAR-10 |
| Network/unknown | `ErrorAlert` with retry; no stack or internal path | AR-22, PAR-10 |

### Accessibility and responsive behavior

- Labels and errors for every field; `aria-describedby` where the component supports it.
- Dialog focus trap and restore; Escape closes unless a request is in flight.
- Table caption and header scope.
- Status text plus icon; no color-only meaning.
- The action row wraps; the table scrolls horizontally at 768 px.
- Add the list and detail to `apps/web/tests/accessibility.test.tsx`. [AR-30, PAR-15]

## New Types and Interfaces

The page types derive from the generated client:

```ts
type CertificateMetadata = Awaited<
  ReturnType<OpenVaultWebClient["certificates"]["listCertificates"]>
>["certificates"][number];
```

No new domain types are introduced; the API contract owns the shape. The dialog props and the
`Filters` interface are local to their files.

## Integration Points

- `useProject()` supplies the project name and id.
- `useSessionApi()` supplies the generated client.
- `useAsync` loads the list and metadata.
- `ErrorAlert`, `AsyncPanel`, `EmptyState`, `Loading`, `DataTable`, `PageHeader`, `NavButton`,
  `StatusBadge`, `formatTime`, `formatTags`, `useConfirm`, and `parseTagLines` are reused.
- `copyCredential` is reused only for public material; private keys use `downloadPem`, not the
  clipboard. [AR-16]

## Testing Requirements

- Component tests for the list, detail, import, generate, metadata, lifecycle, and private key.
- A navigation/docs-mapping test.
- Axe checks for the list and detail.
- No test asserts a private key in storage, the URL, the console, or a clipboard call.
- The full suite passes with `pnpm --filter @openvault/web test`. [AR-25, PAR-11, PAR-15]

## Error Handling Traceability

Every design choice in this document traces to an `AR-*` or `PAR-*` entry. The RD owns the product
error text; this document owns the presentation. No error path renders raw server internals.
