-- blendsdk-migration: 1
-- id: 20261107010908_audit-prune-authorization
-- transaction: true
-- from-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c
-- to-snapshot: 6806576fdf7e758415a6314cd8ba0dbd1a6e53be30375a4ef8a25cd80c2e10a5
CREATE TABLE "public"."audit_prune_authorizations" (
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "cutoff" timestamptz NOT NULL,
  "database_name" text NOT NULL,
  "expected_count" integer NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "export_sha256" bytea NOT NULL,
  "id" text NOT NULL,
  "last_event_id" bigint NOT NULL,
  "last_hash" bytea NOT NULL
);
CREATE TABLE "public"."audit_prune_receipts" (
  "authorization_id" text NOT NULL,
  "completed_at" timestamptz DEFAULT now() NOT NULL,
  "database_name" text NOT NULL,
  "deleted_count" integer NOT NULL,
  "export_sha256" bytea NOT NULL,
  "last_event_id" bigint NOT NULL,
  "last_hash" bytea NOT NULL
);
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_93adfe320e_check" CHECK (octet_length(last_hash) = 32);
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_e74dd8e686_check" CHECK (expected_count >= 0);
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_e7cb13a6d2_check" CHECK (octet_length(export_sha256) = 32);
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_f7d4091c11_check" CHECK (length(database_name) BETWEEN 1 AND 63);
ALTER TABLE "public"."audit_prune_authorizations" ADD CONSTRAINT "audit_prune_authorizations_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_8342612916_check" CHECK (deleted_count >= 0);
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_93adfe320e_check" CHECK (octet_length(last_hash) = 32);
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_authorization_id_pkey" PRIMARY KEY ("authorization_id");
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_e7cb13a6d2_check" CHECK (octet_length(export_sha256) = 32);
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_f7d4091c11_check" CHECK (length(database_name) BETWEEN 1 AND 63);
ALTER TABLE "public"."audit_prune_receipts" ADD CONSTRAINT "audit_prune_receipts_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "public"."audit_prune_authorizations" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;
CREATE INDEX "audit_prune_authorizations_expires_idx" ON "public"."audit_prune_authorizations" ("expires_at");
