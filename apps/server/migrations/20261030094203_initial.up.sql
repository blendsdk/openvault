-- blendsdk-migration: 1
-- id: 20261030094203_initial
-- transaction: true
-- from-snapshot: none
-- to-snapshot: dcbd59d6b606aa4e35d54b3776cba9007c32557815a556c206754780ba4a8d17
CREATE TABLE "public"."audit_checkpoints" (
  "audit_key_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "hmac" bytea NOT NULL,
  "id" bigserial NOT NULL,
  "last_event_id" bigint NOT NULL,
  "last_hash" bytea NOT NULL
);
CREATE TABLE "public"."audit_events" (
  "action" text NOT NULL,
  "actor_id" text,
  "actor_kind" text NOT NULL,
  "audit_key_id" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "event_id" text NOT NULL,
  "hash" bytea NOT NULL,
  "hmac" bytea NOT NULL,
  "id" bigserial NOT NULL,
  "object_id" text,
  "object_type" text,
  "prev_hash" bytea NOT NULL,
  "project_id" text,
  "request_id" text NOT NULL,
  "result" text NOT NULL,
  "scope_id" text,
  "scope_type" text NOT NULL,
  "source_ip" inet,
  "ts" timestamptz DEFAULT now() NOT NULL,
  "user_agent" text
);
CREATE TABLE "public"."audit_keys" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "id" text NOT NULL,
  "kek_id" text NOT NULL,
  "wrap_nonce" bytea NOT NULL,
  "wrap_tag" bytea NOT NULL,
  "wrapped_key" bytea NOT NULL
);
CREATE TABLE "public"."certificate_versions" (
  "certificate_id" text NOT NULL,
  "chain_pem" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "fingerprint" text NOT NULL,
  "id" text NOT NULL,
  "issuer" text NOT NULL,
  "kek_id" text NOT NULL,
  "nonce" bytea NOT NULL,
  "not_after" timestamptz NOT NULL,
  "not_before" timestamptz NOT NULL,
  "sans" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "serial" text NOT NULL,
  "subject" text NOT NULL,
  "tag" bytea NOT NULL,
  "wrap_nonce" bytea NOT NULL,
  "wrap_tag" bytea NOT NULL,
  "wrapped_dek" bytea NOT NULL
);
CREATE TABLE "public"."certificates" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "current_version_id" text,
  "deleted_at" timestamptz,
  "id" text NOT NULL,
  "name" text NOT NULL,
  "project_id" text NOT NULL,
  "purge_after" timestamptz,
  "purge_protected" boolean DEFAULT FALSE NOT NULL,
  "tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "public"."cli_sessions" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "family_id" text NOT NULL,
  "id" text NOT NULL,
  "ip" inet,
  "principal_id" text NOT NULL,
  "refresh_hash" bytea NOT NULL,
  "revoked_at" timestamptz,
  "user_agent" text
);
CREATE TABLE "public"."consumers" (
  "compose_project" text NOT NULL,
  "compose_service" text NOT NULL,
  "first_seen" timestamptz DEFAULT now() NOT NULL,
  "hostname" text NOT NULL,
  "id" text NOT NULL,
  "last_seen" timestamptz DEFAULT now() NOT NULL,
  "manifest_hash" text NOT NULL,
  "principal_id" text NOT NULL,
  "project_id" text NOT NULL,
  "state" text DEFAULT 'ok' NOT NULL
);
CREATE TABLE "public"."idempotency_keys" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "key" text NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "principal_id" text NOT NULL,
  "request_hash" bytea NOT NULL,
  "resource_id" text,
  "status" integer NOT NULL
);
CREATE TABLE "public"."join_tokens" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "principal_id" text NOT NULL,
  "project_id" text NOT NULL,
  "token_hash" bytea NOT NULL,
  "used_at" timestamptz
);
CREATE TABLE "public"."local_credentials" (
  "failed_count" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamptz,
  "must_change" boolean DEFAULT TRUE NOT NULL,
  "password_hash" text NOT NULL,
  "principal_id" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "public"."oidc_identities" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "issuer" text NOT NULL,
  "principal_id" text NOT NULL,
  "subject" text NOT NULL
);
CREATE TABLE "public"."org" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "id" smallint DEFAULT 1 NOT NULL,
  "name" text NOT NULL
);
CREATE TABLE "public"."principals" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "disabled_at" timestamptz,
  "email" text,
  "id" text NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "owner_project_id" text,
  "status" text DEFAULT 'active' NOT NULL
);
CREATE TABLE "public"."projects" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz,
  "display_name" text,
  "id" text NOT NULL,
  "name" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "public"."role_assignments" (
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz,
  "granted_by" text NOT NULL,
  "id" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text NOT NULL,
  "scope_id" text NOT NULL,
  "scope_type" text NOT NULL
);
CREATE TABLE "public"."secret_versions" (
  "ciphertext" bytea NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text NOT NULL,
  "expires_at" timestamptz,
  "id" text NOT NULL,
  "kek_id" text NOT NULL,
  "nonce" bytea NOT NULL,
  "secret_id" text NOT NULL,
  "tag" bytea NOT NULL,
  "wrap_nonce" bytea NOT NULL,
  "wrap_tag" bytea NOT NULL,
  "wrapped_dek" bytea NOT NULL
);
CREATE TABLE "public"."secrets" (
  "content_type" text DEFAULT 'text/plain' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "current_version_id" text,
  "deleted_at" timestamptz,
  "id" text NOT NULL,
  "name" text NOT NULL,
  "project_id" text NOT NULL,
  "purge_after" timestamptz,
  "purge_protected" boolean DEFAULT FALSE NOT NULL,
  "tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "public"."workload_certs" (
  "fingerprint" text NOT NULL,
  "id" text NOT NULL,
  "issued_at" timestamptz DEFAULT now() NOT NULL,
  "not_after" timestamptz NOT NULL,
  "not_before" timestamptz NOT NULL,
  "principal_id" text NOT NULL,
  "revoked_at" timestamptz,
  "serial" text NOT NULL
);
ALTER TABLE "public"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_1c138c5698_check" CHECK (octet_length(hmac) = 32);
ALTER TABLE "public"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_93adfe320e_check" CHECK (octet_length(last_hash) = 32);
ALTER TABLE "public"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_last_event_id_key" UNIQUE ("last_event_id");
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_001f993cb8_check" CHECK (object_type IS NULL OR length(object_type) <= 64);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_0b3c34d80f_check" CHECK (event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_1c138c5698_check" CHECK (octet_length(hmac) = 32);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_1dd8a8c54e_check" CHECK (user_agent IS NULL OR length(user_agent) <= 512);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_1f0cbbf10c_check" CHECK ((scope_type IN ('project', 'object') AND project_id IS NOT NULL) OR scope_type IN ('org', 'system'));
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_1f52f02f93_check" CHECK (octet_length(prev_hash) = 32);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_21015d316c_check" CHECK (octet_length(hash) = 32);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_2c6a28d68d_check" CHECK (length(action) BETWEEN 1 AND 100);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_381f1a6f59_check" CHECK (scope_type IN ('org', 'project', 'object', 'system'));
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_57aa2b5b28_check" CHECK (actor_kind IN ('user', 'service', 'system'));
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_5fff83c188_check" CHECK (length(request_id) BETWEEN 1 AND 100);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_6fb31c0932_check" CHECK (result IN ('allow', 'deny', 'error'));
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_7bbb0037aa_check" CHECK (actor_kind <> 'system' OR actor_id IS NULL);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_925da81d9a_check" CHECK (object_id IS NULL OR length(object_id) <= 64);
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_c7688c3bc3_check" CHECK (jsonb_typeof(details) = 'object');
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_event_id_key" UNIQUE ("event_id");
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_29581f1676_check" CHECK (octet_length(wrap_nonce) = 12);
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_2f4050c033_check" CHECK (octet_length(wrapped_key) = 32);
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_9878f8ddc0_check" CHECK (octet_length(wrap_tag) = 16);
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_a9e2e02429_check" CHECK (length(kek_id) BETWEEN 1 AND 64);
ALTER TABLE "public"."audit_keys" ADD CONSTRAINT "audit_keys_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_29581f1676_check" CHECK (octet_length(wrap_nonce) = 12);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_5a2f736030_check" CHECK (not_after > not_before);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_5fa93815b3_check" CHECK (length(subject) <= 1024);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_6cf6c418f2_check" CHECK (octet_length(ciphertext) <= 131072);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_923a07bf74_check" CHECK (octet_length(wrapped_dek) = 32);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_9878f8ddc0_check" CHECK (octet_length(wrap_tag) = 16);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_a89065b2e6_check" CHECK (length(fingerprint) BETWEEN 1 AND 128);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_a9e2e02429_check" CHECK (length(kek_id) BETWEEN 1 AND 64);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_b63ef1e3c9_check" CHECK (octet_length(nonce) = 12);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_b6967a477b_check" CHECK (length(serial) BETWEEN 1 AND 128);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_c6908b2e5c_check" CHECK (jsonb_typeof(sans) = 'array');
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_certificate_id_id_key" UNIQUE ("certificate_id", "id");
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_d60e88ea28_check" CHECK (octet_length(tag) = 16);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_e6cebd2bfb_check" CHECK (length(chain_pem) <= 131072);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_eec144ae3c_check" CHECK (length(issuer) <= 1024);
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_27f5575b8e_check" CHECK (jsonb_typeof(tags) = 'object');
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_5cd7f14688_check" CHECK (purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at));
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_b7cbe37e00_check" CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$');
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_id_current_version_id_key" UNIQUE ("id", "current_version_id");
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_09ccf1091c_check" CHECK (octet_length(refresh_hash) = 32);
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_1dd8a8c54e_check" CHECK (user_agent IS NULL OR length(user_agent) <= 512);
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_90ebc7a6d2_check" CHECK (family_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_refresh_hash_key" UNIQUE ("refresh_hash");
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_10f81250b1_check" CHECK (length(compose_project) BETWEEN 1 AND 100);
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_7fcda2e7f4_check" CHECK (state IN ('ok', 'degraded', 'failed'));
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_a8f0f8bd6d_check" CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_bc49ebf068_check" CHECK (length(compose_service) BETWEEN 1 AND 100);
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_e954fefd8e_check" CHECK (hostname ~ '^[A-Za-z0-9._-]{1,255}$');
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_principal_id_key" UNIQUE ("principal_id");
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_1e4f3e2834_check" CHECK (status BETWEEN 100 AND 599);
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_5ae97aa1e4_check" CHECK (length(key) BETWEEN 1 AND 200);
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_62c12f0da3_check" CHECK (length(path) BETWEEN 1 AND 500);
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_ade8981e79_check" CHECK (octet_length(request_hash) = 32);
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_f937a7b1ca_check" CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE'));
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_principal_id_key_pkey" PRIMARY KEY ("principal_id", "key");
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_d3ea639f7f_check" CHECK (octet_length(token_hash) = 32);
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_token_hash_key" UNIQUE ("token_hash");
ALTER TABLE "public"."local_credentials" ADD CONSTRAINT "local_credentials_2df8ef154d_check" CHECK (password_hash ~ '^\$argon2id\$');
ALTER TABLE "public"."local_credentials" ADD CONSTRAINT "local_credentials_fdd23b182b_check" CHECK (failed_count >= 0);
ALTER TABLE "public"."local_credentials" ADD CONSTRAINT "local_credentials_principal_id_pkey" PRIMARY KEY ("principal_id");
ALTER TABLE "public"."oidc_identities" ADD CONSTRAINT "oidc_identities_a1e30a06ce_check" CHECK (length(issuer) BETWEEN 1 AND 255);
ALTER TABLE "public"."oidc_identities" ADD CONSTRAINT "oidc_identities_d298fa8c53_check" CHECK (length(subject) BETWEEN 1 AND 255);
ALTER TABLE "public"."oidc_identities" ADD CONSTRAINT "oidc_identities_issuer_subject_pkey" PRIMARY KEY ("issuer", "subject");
ALTER TABLE "public"."org" ADD CONSTRAINT "org_bf0fbc73ee_check" CHECK (length(name) BETWEEN 1 AND 100);
ALTER TABLE "public"."org" ADD CONSTRAINT "org_cec3cc2294_check" CHECK (id = 1);
ALTER TABLE "public"."org" ADD CONSTRAINT "org_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_50bdb8d931_check" CHECK ((kind = 'service' AND owner_project_id IS NOT NULL) OR (kind = 'user' AND owner_project_id IS NULL));
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_60551f8172_check" CHECK (kind IN ('user', 'service'));
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_8f0d3cac8b_check" CHECK ((status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL));
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_bf0fbc73ee_check" CHECK (length(name) BETWEEN 1 AND 100);
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_eec5b4891c_check" CHECK (status IN ('active', 'disabled'));
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_id_owner_project_id_key" UNIQUE ("id", "owner_project_id");
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."projects" ADD CONSTRAINT "projects_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."projects" ADD CONSTRAINT "projects_a1b063b729_check" CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
ALTER TABLE "public"."projects" ADD CONSTRAINT "projects_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_3990dfecde_check" CHECK (scope_type <> 'object' OR role IN ('secrets.reader', 'certificates.reader'));
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_6314e762c6_check" CHECK (scope_type IN ('org', 'project', 'object'));
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_c39e07fba4_check" CHECK ((scope_type = 'org' AND scope_id = 'org') OR (scope_type IN ('project', 'object') AND scope_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'));
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_d1bc25e769_check" CHECK (role IN ('org.admin', 'project.admin', 'secrets.manager', 'secrets.officer', 'secrets.reader', 'certificates.officer', 'certificates.reader', 'auditor', 'reader'));
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_principal_id_role_scope_type_scope_id_key" UNIQUE ("principal_id", "role", "scope_type", "scope_id");
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_29581f1676_check" CHECK (octet_length(wrap_nonce) = 12);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_923a07bf74_check" CHECK (octet_length(wrapped_dek) = 32);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_9878f8ddc0_check" CHECK (octet_length(wrap_tag) = 16);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_a9e2e02429_check" CHECK (length(kek_id) BETWEEN 1 AND 64);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_b63ef1e3c9_check" CHECK (octet_length(nonce) = 12);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_d3f7991c45_check" CHECK (octet_length(ciphertext) <= 65536);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_d60e88ea28_check" CHECK (octet_length(tag) = 16);
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_secret_id_id_key" UNIQUE ("secret_id", "id");
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_180bff05b7_check" CHECK (length(content_type) BETWEEN 1 AND 128);
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_27f5575b8e_check" CHECK (jsonb_typeof(tags) = 'object');
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_5cd7f14688_check" CHECK (purge_after IS NULL OR (deleted_at IS NOT NULL AND purge_after >= deleted_at));
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_b7cbe37e00_check" CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,126}$');
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_id_current_version_id_key" UNIQUE ("id", "current_version_id");
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_5a2f736030_check" CHECK (not_after > not_before);
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_a89065b2e6_check" CHECK (length(fingerprint) BETWEEN 1 AND 128);
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_b6967a477b_check" CHECK (length(serial) BETWEEN 1 AND 128);
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_fingerprint_key" UNIQUE ("fingerprint");
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_serial_key" UNIQUE ("serial");
ALTER TABLE "public"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_audit_key_id_fkey" FOREIGN KEY ("audit_key_id") REFERENCES "public"."audit_keys" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_audit_key_id_fkey" FOREIGN KEY ("audit_key_id") REFERENCES "public"."audit_keys" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."certificate_versions" ADD CONSTRAINT "certificate_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_id_current_version_id_fkey" FOREIGN KEY ("id", "current_version_id") REFERENCES "public"."certificate_versions" ("certificate_id", "id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "public"."certificates" ADD CONSTRAINT "certificates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."cli_sessions" ADD CONSTRAINT "cli_sessions_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_principal_id_project_id_fkey" FOREIGN KEY ("principal_id", "project_id") REFERENCES "public"."principals" ("id", "owner_project_id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."consumers" ADD CONSTRAINT "consumers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_principal_id_project_id_fkey" FOREIGN KEY ("principal_id", "project_id") REFERENCES "public"."principals" ("id", "owner_project_id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."join_tokens" ADD CONSTRAINT "join_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."local_credentials" ADD CONSTRAINT "local_credentials_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."oidc_identities" ADD CONSTRAINT "oidc_identities_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."principals" ADD CONSTRAINT "principals_owner_project_id_fkey" FOREIGN KEY ("owner_project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "role_assignments_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "public"."secret_versions" ADD CONSTRAINT "secret_versions_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_id_current_version_id_fkey" FOREIGN KEY ("id", "current_version_id") REFERENCES "public"."secret_versions" ("secret_id", "id") ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE "public"."workload_certs" ADD CONSTRAINT "workload_certs_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "public"."principals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
CREATE INDEX "audit_events_action_idx" ON "public"."audit_events" ("action");
CREATE INDEX "audit_events_actor_idx" ON "public"."audit_events" ("actor_id");
CREATE INDEX "audit_events_object_idx" ON "public"."audit_events" ("object_type", "object_id");
CREATE INDEX "audit_events_project_idx" ON "public"."audit_events" ("project_id", "ts");
CREATE INDEX "audit_events_request_idx" ON "public"."audit_events" ("request_id");
CREATE INDEX "audit_events_result_idx" ON "public"."audit_events" ("result");
CREATE INDEX "audit_events_ts_idx" ON "public"."audit_events" ("ts");
CREATE INDEX "certificate_versions_certificate_idx" ON "public"."certificate_versions" ("certificate_id", "created_at");
CREATE UNIQUE INDEX "certificates_name_active_idx" ON "public"."certificates" ("project_id", "name") WHERE deleted_at IS NULL;
CREATE INDEX "certificates_project_idx" ON "public"."certificates" ("project_id");
CREATE INDEX "cli_sessions_family_idx" ON "public"."cli_sessions" ("family_id");
CREATE INDEX "cli_sessions_principal_idx" ON "public"."cli_sessions" ("principal_id");
CREATE INDEX "consumers_project_idx" ON "public"."consumers" ("project_id");
CREATE INDEX "idempotency_keys_expires_idx" ON "public"."idempotency_keys" ("expires_at");
CREATE INDEX "join_tokens_principal_idx" ON "public"."join_tokens" ("principal_id");
CREATE INDEX "principals_owner_idx" ON "public"."principals" ("owner_project_id");
CREATE UNIQUE INDEX "principals_user_email_idx" ON "public"."principals" (lower(email)) WHERE kind = 'user' AND email IS NOT NULL;
CREATE UNIQUE INDEX "projects_name_active_idx" ON "public"."projects" ("name") WHERE deleted_at IS NULL;
CREATE INDEX "role_assignments_principal_idx" ON "public"."role_assignments" ("principal_id");
CREATE INDEX "role_assignments_scope_idx" ON "public"."role_assignments" ("scope_type", "scope_id");
CREATE INDEX "secret_versions_secret_idx" ON "public"."secret_versions" ("secret_id", "created_at");
CREATE UNIQUE INDEX "secrets_name_active_idx" ON "public"."secrets" ("project_id", "name") WHERE deleted_at IS NULL;
CREATE INDEX "secrets_project_idx" ON "public"."secrets" ("project_id");
CREATE INDEX "workload_certs_principal_idx" ON "public"."workload_certs" ("principal_id");
