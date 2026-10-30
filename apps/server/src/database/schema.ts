import { DatabaseSchema } from "blendsdk/codegen";

/**
 * Desired PostgreSQL schema for OpenVault.
 *
 * The model is the single source of truth for generated migrations and for the generated
 * row types produced from a migrated database. PostgreSQL objects that the model cannot
 * express, such as the audit and version-protection triggers, live in a reviewed manual
 * migration.
 */
const db = new DatabaseSchema("openvault");

/**
 * Builds a ULID check for a text column.
 *
 * @param column - Column name to validate.
 * @returns SQL check expression.
 */
function ulidExpression(column: string): string {
  return `${column} ~ '^[0-9A-HJKMNP-TV-Z]{26}$'`;
}

/**
 * Builds a length check for a text column.
 *
 * @param column - Column name.
 * @param minimum - Minimum length.
 * @param maximum - Maximum length.
 * @returns SQL check expression.
 */
function lengthBetween(column: string, minimum: number, maximum: number): string {
  return `length(${column}) BETWEEN ${minimum} AND ${maximum}`;
}

// ---------------------------------------------------------------------------
// Organization, projects, and principals
// ---------------------------------------------------------------------------

const org = db.table("org");
org.smallint("id").default(1);
org.text("name").check(lengthBetween("name", 1, 100));
org.timestamptz("created_at").default("now()");
org.primaryKey().column("id");
org.checkConstraint("id = 1");

const projects = db.table("projects");
projects.text("id").check(ulidExpression("id"));
projects.text("name").check("name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'");
projects.text("display_name").nullable();
projects.timestamptz("created_at").default("now()");
projects.timestamptz("updated_at").default("now()");
projects.timestamptz("deleted_at").nullable();
projects.primaryKey().column("id");
projects
  .index()
  .indexName("projects_name_active_idx")
  .unique()
  .column("name")
  .where("deleted_at IS NULL");

const principals = db.table("principals");
principals.text("id").check(ulidExpression("id"));
principals.text("kind").check("kind IN ('user', 'service')");
principals.text("name").check(lengthBetween("name", 1, 100));
principals.text("email").nullable();
principals.text("owner_project_id").nullable();
principals.text("status").default("active", true).check("status IN ('active', 'disabled')");
principals.timestamptz("created_at").default("now()");
principals.timestamptz("disabled_at").nullable();
principals.primaryKey().column("id");
principals.uniqueConstraint().column("id", "owner_project_id");
principals.checkConstraint(
  "(kind = 'service' AND owner_project_id IS NOT NULL) OR (kind = 'user' AND owner_project_id IS NULL)",
);
principals.checkConstraint(
  "(status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL)",
);
principals.index().column("owner_project_id").indexName("principals_owner_idx");
principals
  .index()
  .indexName("principals_user_email_idx")
  .unique()
  .column("email")
  .expression("lower(email)")
  .where("kind = 'user' AND email IS NOT NULL");

// ---------------------------------------------------------------------------
// Credentials and CLI sessions
// ---------------------------------------------------------------------------

const localCredentials = db.table("local_credentials");
localCredentials.text("principal_id");
localCredentials.text("password_hash").check("password_hash ~ '^\\$argon2id\\$'");
localCredentials.boolean("must_change").default(true);
localCredentials.integer("failed_count").default(0).check("failed_count >= 0");
localCredentials.timestamptz("locked_until").nullable();
localCredentials.timestamptz("updated_at").default("now()");
localCredentials.primaryKey().column("principal_id");

const oidcIdentities = db.table("oidc_identities");
oidcIdentities.text("principal_id");
oidcIdentities.text("issuer").check(lengthBetween("issuer", 1, 255));
oidcIdentities.text("subject").check(lengthBetween("subject", 1, 255));
oidcIdentities.timestamptz("created_at").default("now()");
oidcIdentities.primaryKey().column("issuer", "subject");

const cliSessions = db.table("cli_sessions");
cliSessions.text("id").check(ulidExpression("id"));
cliSessions.text("principal_id");
cliSessions.bytea("refresh_hash").unique().check("octet_length(refresh_hash) = 32");
cliSessions.text("family_id").check(ulidExpression("family_id"));
cliSessions.timestamptz("expires_at");
cliSessions.timestamptz("revoked_at").nullable();
cliSessions.timestamptz("created_at").default("now()");
cliSessions.inet("ip").nullable();
cliSessions.text("user_agent").nullable().check("user_agent IS NULL OR length(user_agent) <= 512");
cliSessions.primaryKey().column("id");
cliSessions.index().column("principal_id").indexName("cli_sessions_principal_idx");
cliSessions.index().column("family_id").indexName("cli_sessions_family_idx");

// ---------------------------------------------------------------------------
// Workload identity and consumers
// ---------------------------------------------------------------------------

const workloadCerts = db.table("workload_certs");
workloadCerts.text("id").check(ulidExpression("id"));
workloadCerts.text("principal_id");
workloadCerts
  .text("serial")
  .unique()
  .check(lengthBetween("serial", 1, 128));
workloadCerts
  .text("fingerprint")
  .unique()
  .check(lengthBetween("fingerprint", 1, 128));
workloadCerts.timestamptz("not_before");
workloadCerts.timestamptz("not_after");
workloadCerts.timestamptz("revoked_at").nullable();
workloadCerts.timestamptz("issued_at").default("now()");
workloadCerts.primaryKey().column("id");
workloadCerts.checkConstraint("not_after > not_before");
workloadCerts.index().column("principal_id").indexName("workload_certs_principal_idx");

const joinTokens = db.table("join_tokens");
joinTokens.text("id").check(ulidExpression("id"));
joinTokens.bytea("token_hash").unique().check("octet_length(token_hash) = 32");
joinTokens.text("principal_id");
joinTokens.text("project_id");
joinTokens.timestamptz("expires_at");
joinTokens.timestamptz("used_at").nullable();
joinTokens.text("created_by");
joinTokens.timestamptz("created_at").default("now()");
joinTokens.primaryKey().column("id");
joinTokens.index().column("principal_id").indexName("join_tokens_principal_idx");

const consumers = db.table("consumers");
consumers.text("id").check(ulidExpression("id"));
consumers.text("principal_id").unique();
consumers.text("project_id");
consumers.text("compose_project").check(lengthBetween("compose_project", 1, 100));
consumers.text("compose_service").check(lengthBetween("compose_service", 1, 100));
consumers.text("hostname").check("hostname ~ '^[A-Za-z0-9._-]{1,255}$'");
consumers.text("manifest_hash").check("manifest_hash ~ '^sha256:[0-9a-f]{64}$'");
consumers.timestamptz("first_seen").default("now()");
consumers.timestamptz("last_seen").default("now()");
consumers.text("state").default("ok", true).check("state IN ('ok', 'degraded', 'failed')");
consumers.primaryKey().column("id");
consumers.index().column("project_id").indexName("consumers_project_idx");

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

const roleAssignments = db.table("role_assignments");
roleAssignments.text("id").check(ulidExpression("id"));
roleAssignments.text("principal_id");
roleAssignments
  .text("role")
  .check(
    "role IN ('org.admin', 'project.admin', 'secrets.manager', 'secrets.officer', 'secrets.reader', 'certificates.officer', 'certificates.reader', 'auditor', 'reader')",
  );
roleAssignments.text("scope_type").check("scope_type IN ('org', 'project', 'object')");
roleAssignments.text("scope_id");
roleAssignments.text("granted_by");
roleAssignments.timestamptz("created_at").default("now()");
roleAssignments.timestamptz("expires_at").nullable();
roleAssignments.primaryKey().column("id");
roleAssignments.uniqueConstraint().column("principal_id", "role", "scope_type", "scope_id");
roleAssignments.checkConstraint(
  "(scope_type = 'org' AND scope_id = 'org') OR (scope_type IN ('project', 'object') AND scope_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$')",
);
roleAssignments.checkConstraint(
  "scope_type <> 'object' OR role IN ('secrets.reader', 'certificates.reader')",
);
roleAssignments.index().column("principal_id").indexName("role_assignments_principal_idx");
roleAssignments.index().column("scope_type", "scope_id").indexName("role_assignments_scope_idx");

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const secrets = db.table("secrets");
secrets.text("id").check(ulidExpression("id"));
secrets.text("project_id");
secrets.text("name").check("name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$'");
secrets.text("current_version_id").nullable();
secrets.jsonb("tags").default("'{}'::jsonb").check("jsonb_typeof(tags) = 'object'");
secrets
  .text("content_type")
  .default("text/plain", true)
  .check(lengthBetween("content_type", 1, 128));
secrets.boolean("purge_protected").default(false);
secrets.timestamptz("created_at").default("now()");
secrets.timestamptz("updated_at").default("now()");
secrets.timestamptz("deleted_at").nullable();
secrets.timestamptz("purge_after").nullable();
secrets.primaryKey().column("id");
secrets.uniqueConstraint().column("id", "current_version_id");
secrets.checkConstraint(
  "purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at)",
);
secrets
  .index()
  .indexName("secrets_name_active_idx")
  .unique()
  .column("project_id", "name")
  .where("deleted_at IS NULL");
secrets.index().column("project_id").indexName("secrets_project_idx");

const secretVersions = db.table("secret_versions");
secretVersions.text("id").check(ulidExpression("id"));
secretVersions.text("secret_id");
secretVersions.bytea("ciphertext").check("octet_length(ciphertext) <= 65536");
secretVersions.bytea("nonce").check("octet_length(nonce) = 12");
secretVersions.bytea("tag").check("octet_length(tag) = 16");
secretVersions.bytea("wrapped_dek").check("octet_length(wrapped_dek) = 32");
secretVersions.bytea("wrap_nonce").check("octet_length(wrap_nonce) = 12");
secretVersions.bytea("wrap_tag").check("octet_length(wrap_tag) = 16");
secretVersions.text("kek_id").check(lengthBetween("kek_id", 1, 64));
secretVersions.text("created_by");
secretVersions.timestamptz("created_at").default("now()");
secretVersions.timestamptz("expires_at").nullable();
secretVersions.primaryKey().column("id");
secretVersions.uniqueConstraint().column("secret_id", "id");
secretVersions.index().indexName("secret_versions_secret_idx").column("secret_id", "created_at");

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

const certificates = db.table("certificates");
certificates.text("id").check(ulidExpression("id"));
certificates.text("project_id");
certificates.text("name").check("name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$'");
certificates.text("current_version_id").nullable();
certificates.jsonb("tags").default("'{}'::jsonb").check("jsonb_typeof(tags) = 'object'");
certificates.boolean("purge_protected").default(false);
certificates.timestamptz("created_at").default("now()");
certificates.timestamptz("updated_at").default("now()");
certificates.timestamptz("deleted_at").nullable();
certificates.timestamptz("purge_after").nullable();
certificates.primaryKey().column("id");
certificates.uniqueConstraint().column("id", "current_version_id");
certificates.checkConstraint(
  "purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at)",
);
certificates
  .index()
  .indexName("certificates_name_active_idx")
  .unique()
  .column("project_id", "name")
  .where("deleted_at IS NULL");
certificates.index().column("project_id").indexName("certificates_project_idx");

const certificateVersions = db.table("certificate_versions");
certificateVersions.text("id").check(ulidExpression("id"));
certificateVersions.text("certificate_id");
certificateVersions.text("chain_pem").check("length(chain_pem) <= 131072");
certificateVersions.bytea("ciphertext").check("octet_length(ciphertext) <= 131072");
certificateVersions.bytea("nonce").check("octet_length(nonce) = 12");
certificateVersions.bytea("tag").check("octet_length(tag) = 16");
certificateVersions.bytea("wrapped_dek").check("octet_length(wrapped_dek) = 32");
certificateVersions.bytea("wrap_nonce").check("octet_length(wrap_nonce) = 12");
certificateVersions.bytea("wrap_tag").check("octet_length(wrap_tag) = 16");
certificateVersions.text("kek_id").check(lengthBetween("kek_id", 1, 64));
certificateVersions.text("fingerprint").check(lengthBetween("fingerprint", 1, 128));
certificateVersions.text("subject").check("length(subject) <= 1024");
certificateVersions.jsonb("sans").default("'[]'::jsonb").check("jsonb_typeof(sans) = 'array'");
certificateVersions.text("issuer").check("length(issuer) <= 1024");
certificateVersions.text("serial").check(lengthBetween("serial", 1, 128));
certificateVersions.timestamptz("not_before");
certificateVersions.timestamptz("not_after");
certificateVersions.text("created_by");
certificateVersions.timestamptz("created_at").default("now()");
certificateVersions.primaryKey().column("id");
certificateVersions.uniqueConstraint().column("certificate_id", "id");
certificateVersions.checkConstraint("not_after > not_before");
certificateVersions
  .index()
  .indexName("certificate_versions_certificate_idx")
  .column("certificate_id", "created_at");

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const auditKeys = db.table("audit_keys");
auditKeys.text("id").check(ulidExpression("id"));
auditKeys.bytea("wrapped_key").check("octet_length(wrapped_key) = 32");
auditKeys.bytea("wrap_nonce").check("octet_length(wrap_nonce) = 12");
auditKeys.bytea("wrap_tag").check("octet_length(wrap_tag) = 16");
auditKeys.text("kek_id").check(lengthBetween("kek_id", 1, 64));
auditKeys.timestamptz("created_at").default("now()");
auditKeys.primaryKey().column("id");

const auditEvents = db.table("audit_events");
auditEvents.bigserial("id");
auditEvents.text("event_id").check(ulidExpression("event_id"));
auditEvents.timestamptz("ts").default("now()");
auditEvents.text("project_id").nullable();
auditEvents.text("request_id").check(lengthBetween("request_id", 1, 100));
auditEvents.text("actor_id").nullable();
auditEvents.text("actor_kind").check("actor_kind IN ('user', 'service', 'system')");
auditEvents.text("action").check(lengthBetween("action", 1, 100));
auditEvents.text("scope_type").check("scope_type IN ('org', 'project', 'object', 'system')");
auditEvents.text("scope_id").nullable();
auditEvents
  .text("object_type")
  .nullable()
  .check("object_type IS NULL OR length(object_type) <= 64");
auditEvents.text("object_id").nullable().check("object_id IS NULL OR length(object_id) <= 64");
auditEvents.text("result").check("result IN ('allow', 'deny', 'error')");
auditEvents.inet("source_ip").nullable();
auditEvents.text("user_agent").nullable().check("user_agent IS NULL OR length(user_agent) <= 512");
auditEvents.jsonb("details").default("'{}'::jsonb").check("jsonb_typeof(details) = 'object'");
auditEvents.bytea("prev_hash").check("octet_length(prev_hash) = 32");
auditEvents.bytea("hash").check("octet_length(hash) = 32");
auditEvents.bytea("hmac").check("octet_length(hmac) = 32");
auditEvents.text("audit_key_id");
auditEvents.primaryKey().column("id");
auditEvents.uniqueConstraint().column("event_id");
auditEvents.checkConstraint(
  "(scope_type IN ('project', 'object') AND project_id IS NOT NULL) OR scope_type IN ('org', 'system')",
);
auditEvents.checkConstraint("actor_kind <> 'system' OR actor_id IS NULL");
auditEvents.index().column("ts").indexName("audit_events_ts_idx");
auditEvents.index().column("project_id", "ts").indexName("audit_events_project_idx");
auditEvents.index().column("actor_id").indexName("audit_events_actor_idx");
auditEvents.index().column("action").indexName("audit_events_action_idx");
auditEvents.index().column("object_type", "object_id").indexName("audit_events_object_idx");
auditEvents.index().column("result").indexName("audit_events_result_idx");
auditEvents.index().column("request_id").indexName("audit_events_request_idx");

const auditCheckpoints = db.table("audit_checkpoints");
auditCheckpoints.bigserial("id");
auditCheckpoints.bigint("last_event_id").unique();
auditCheckpoints.bytea("last_hash").check("octet_length(last_hash) = 32");
auditCheckpoints.bytea("hmac").check("octet_length(hmac) = 32");
auditCheckpoints.text("audit_key_id");
auditCheckpoints.timestamptz("created_at").default("now()");
auditCheckpoints.primaryKey().column("id");

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

const idempotencyKeys = db.table("idempotency_keys");
idempotencyKeys.text("principal_id");
idempotencyKeys.text("key").check(lengthBetween("key", 1, 200));
idempotencyKeys.text("method").check("method IN ('POST', 'PUT', 'PATCH', 'DELETE')");
idempotencyKeys.text("path").check(lengthBetween("path", 1, 500));
idempotencyKeys.bytea("request_hash").check("octet_length(request_hash) = 32");
idempotencyKeys.integer("status").check("status BETWEEN 100 AND 599");
idempotencyKeys.text("resource_id").nullable();
idempotencyKeys.timestamptz("expires_at");
idempotencyKeys.timestamptz("created_at").default("now()");
idempotencyKeys.primaryKey().column("principal_id", "key");
idempotencyKeys.index().column("expires_at").indexName("idempotency_keys_expires_idx");

// ---------------------------------------------------------------------------
// Foreign keys
// ---------------------------------------------------------------------------

principals
  .foreignKeyConstraint(projects)
  .from("owner_project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");

localCredentials
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
oidcIdentities
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
cliSessions
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");

workloadCerts
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
joinTokens
  .foreignKeyConstraint(projects)
  .from("project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");
joinTokens
  .foreignKeyConstraint(principals)
  .from("created_by")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");
joinTokens
  .foreignKeyConstraint(principals)
  .from("principal_id", "project_id")
  .to("id", "owner_project_id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
consumers
  .foreignKeyConstraint(projects)
  .from("project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");
consumers
  .foreignKeyConstraint(principals)
  .from("principal_id", "project_id")
  .to("id", "owner_project_id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");

roleAssignments
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
roleAssignments
  .foreignKeyConstraint(principals)
  .from("granted_by")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");

secrets
  .foreignKeyConstraint(projects)
  .from("project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");
secretVersions
  .foreignKeyConstraint(secrets)
  .from("secret_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
secretVersions
  .foreignKeyConstraint(principals)
  .from("created_by")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");
secrets
  .foreignKeyConstraint(secretVersions)
  .from("id", "current_version_id")
  .to("secret_id", "id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION")
  .deferrable("DEFERRED");

certificates
  .foreignKeyConstraint(projects)
  .from("project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");
certificateVersions
  .foreignKeyConstraint(certificates)
  .from("certificate_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");
certificateVersions
  .foreignKeyConstraint(principals)
  .from("created_by")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");
certificates
  .foreignKeyConstraint(certificateVersions)
  .from("id", "current_version_id")
  .to("certificate_id", "id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION")
  .deferrable("DEFERRED");

auditEvents
  .foreignKeyConstraint(projects)
  .from("project_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("RESTRICT");
auditEvents
  .foreignKeyConstraint(auditKeys)
  .from("audit_key_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");
auditCheckpoints
  .foreignKeyConstraint(auditKeys)
  .from("audit_key_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("NO ACTION");

idempotencyKeys
  .foreignKeyConstraint(principals)
  .from("principal_id")
  .to("id")
  .onUpdate("NO ACTION")
  .onDelete("CASCADE");

export default db;
