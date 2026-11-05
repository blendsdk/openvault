/**
 * Starts a fresh document at one same-origin path.
 *
 * A local login or password change creates a session whose CSRF token and
 * user are already in the response. The BlendSDK auth provider only learns a
 * session from `GET /me`, so the application boots once more after those two
 * flows. This also prevents the previous document's in-memory state from
 * surviving a credential change.
 */
export function reloadTo(path: string): void {
  window.location.assign(path);
}
