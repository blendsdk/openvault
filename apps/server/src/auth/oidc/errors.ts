/** A browser-correctable OIDC flow failure (bad code, state, nonce, or subject). */
export class OidcFlowError extends Error {
  public constructor(message = "Sign-in failed") {
    super(message);
    this.name = "OidcFlowError";
  }
}

/** An identity-provider outage, timeout, or unusable discovery document. */
export class OidcUnavailableError extends Error {
  public constructor(message = "Identity provider unavailable") {
    super(message);
    this.name = "OidcUnavailableError";
  }
}

/** The provider authenticated a principal that the application denies. */
export class OidcAccessDeniedError extends Error {
  public constructor(message = "Access denied") {
    super(message);
    this.name = "OidcAccessDeniedError";
  }
}

/** A verified email already belongs to another principal. */
export class OidcLinkCollisionError extends Error {
  public constructor(message = "Access denied") {
    super(message);
    this.name = "OidcLinkCollisionError";
  }
}
