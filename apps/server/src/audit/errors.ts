/**
 * Base class for audit domain failures.
 *
 * Callers map the concrete subclasses to stable HTTP responses; the message is
 * safe for logs and never contains key material or stored values.
 */
export class AuditError extends Error {
  public constructor(message = "Audit error", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid caller input that must not be written. */
export class AuditInputError extends AuditError {
  public constructor(message = "Invalid audit input") {
    super(message);
  }
}

/** Canonical JSON rejected a value. */
export class CanonicalJsonError extends AuditError {
  public constructor(message = "Value cannot be serialized canonically") {
    super(message);
  }
}

/** Audit persistence or an audit key is unavailable. */
export class AuditUnavailableError extends AuditError {
  public constructor(message = "Audit service unavailable", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** A required audit key cannot be unwrapped. */
export class AuditKeyUnavailableError extends AuditUnavailableError {
  public constructor(message = "Audit key unavailable") {
    super(message);
  }
}

/** A query filter, limit, or cursor is invalid. */
export class AuditQueryError extends AuditError {
  public constructor(message = "Invalid audit query") {
    super(message);
  }
}

/** The caller may not read the requested audit scope. */
export class AuditAccessDeniedError extends AuditError {
  public constructor(message = "Access denied") {
    super(message);
  }
}

/** The prune command is misconfigured. */
export class AuditPruneConfigError extends AuditError {
  public constructor(message = "Audit prune configuration is invalid") {
    super(message);
  }
}
