# Join Token Clipboard: Security Findings Wave 2

> **Document**: 03-05-join-token-clipboard.md
> **Parent**: [Index](00-index.md)

## Overview

Give credential copies a 30-second best-effort clipboard clear. The timer must survive the token dialog closing or the page navigating away, and the result must be visible on the page even after the dialog is gone.

## Architecture

### Current Behavior

`apps/web/src/components/copy.tsx:27-39` writes the value and resets a two-second "Copied" indicator. `apps/web/src/pages/identities-page.tsx:222-226` uses this generic button for the join token. `apps/web/src/pages/secret-detail-page.tsx:142-174` already implements a 30-second clear for revealed secret values.

### Proposed Changes

1. Add a shared credential-copy module `apps/web/src/components/credential-copy.ts`:

   ```ts
   export interface CredentialCopyResult {
     readonly ok: boolean;
     readonly message: string;
   }

   export function scheduleCredentialClear(options: {
     readonly value: string;
     readonly clearAfterMs?: number;
     readonly onResult?: (result: CredentialCopyResult) => void;
   }): Promise<void>;

   export function resetCredentialCopyForTest(): void;
   ```

   The module owns one pending timer. A new successful credential copy cancels the previous timer and schedules a new one. The timer always attempts `navigator.clipboard.writeText("")`; it does not skip because `document.hasFocus()` is false. It reports success, a denied write, or an unavailable clipboard through `onResult`.

2. On the initial copy:
   - Write the value.
   - Only after the write resolves, cancel any previous timer and schedule the clear. If the new write is denied, keep the previous timer so the older sensitive value is still cleared.
   - Report the copy result.

3. Add a `credential` mode to `CopyButton` that calls `scheduleCredentialClear` and forwards results. Keep generic copies (CLI hints) on the existing two-second indicator and no clear.

4. The identities page owns a `clipboardStatus` state and renders a page-level status line outside the dialog. Closing the dialog does not remove the message or cancel the timer. Use the existing warning styling for a denied or unavailable clear.

5. Update `secret-detail-page.tsx` to use the same shared module so the two credential copies share one timer. Copying a join token then a secret value must clear only the newest sensitive value.

6. Status text:
   - `"Copied. The clipboard will be cleared in 30 seconds if the browser allows."`
   - `"Clipboard cleared."`
   - `"Copied token remains on the clipboard; clear it manually."`
   - `"Clipboard clear failed because the browser blocked access; clear it manually."`

7. Add explanatory text in the dialog that the token is shown once and that clipboard clearing is best effort.

## Failure Behavior

- Browser denies the initial copy: show "Clipboard unavailable" and do not cancel an older pending clear.
- Browser denies the clear: show the manual-clear instruction at page level.
- Page is unfocused at 30 seconds: still attempt the write; report a failure if the browser refuses.
- New successful copy before the timer fires: replace the pending timer so only the newest value is cleared.
- Unmount/navigation: the module-level timer still fires.
- Two credential copy components: one shared timer, no double clear.

## Tests

`apps/web/tests/copy.test.tsx` and `apps/web/tests/identities-consumers.test.tsx`:

- Stub `document.hasFocus` (jsdom returns false in a fresh document) or focus the button; copy the join token with fake timers, advance 30 seconds, assert `writeText("")`.
- Close the dialog immediately after copying, advance 30 seconds, assert the clear still runs and the page-level status is visible.
- Mock the first write to resolve and the second (clear) to reject; assert the manual-clear message.
- Copy A, deny copy B, advance 30 seconds, assert A is cleared.
- Assert a non-credential `CopyButton` does not schedule a clear.
- Reset the shared timer in `afterEach`.

## Acceptance

See `07-testing-strategy.md` ST-28…ST-31 and `01-requirements.md` R5.
