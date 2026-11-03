-- blendsdk-migration: 1
-- id: 20261103141309_service-identities
-- transaction: true
-- from-snapshot: aad0caf02c16e7c3612e741ff1a6ecaec800db54d33d879c333169fce50a7fb3
-- to-snapshot: 329526d411d3af98bb252caa1c069b031455ff36b40f2af6a1bf115c7090e199
CREATE TABLE "public"."ca_keys" (
  "activated_at" timestamptz NOT NULL,
  "cert_pem" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "id" text NOT NULL,
  "kek_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  "retired_at" timestamptz,
  "status" text NOT NULL,
  "wrap_nonce" bytea NOT NULL,
  "wrap_tag" bytea NOT NULL,
  "wrapped_key" bytea NOT NULL
);
ALTER TABLE "public"."join_tokens" ADD COLUMN "revoked_at" timestamptz;
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_29581f1676_check" CHECK (octet_length(wrap_nonce) = 12);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_2f4050c033_check" CHECK (octet_length(wrapped_key) = 32);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_64a83c0a06_check" CHECK (status IN ('current', 'retired'));
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_7967c4a0d1_check" CHECK ((status = 'retired' AND retired_at IS NOT NULL) OR (status <> 'retired' AND retired_at IS NULL));
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_9878f8ddc0_check" CHECK (octet_length(wrap_tag) = 16);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_a9e2e02429_check" CHECK (length(kek_id) BETWEEN 1 AND 64);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_b173ea2f46_check" CHECK (octet_length(public_key) = 65);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_f175e3eb8c_check" CHECK (length(cert_pem) BETWEEN 1 AND 16384);
ALTER TABLE "public"."ca_keys" ADD CONSTRAINT "ca_keys_id_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "ca_keys_current_idx" ON "public"."ca_keys" ("status") WHERE status = 'current';
CREATE INDEX "join_tokens_expires_idx" ON "public"."join_tokens" ("expires_at");
CREATE UNIQUE INDEX "principals_service_name_active_idx" ON "public"."principals" ("owner_project_id", "name") WHERE kind = 'service' AND status = 'active';
CREATE INDEX "workload_certs_not_after_idx" ON "public"."workload_certs" ("not_after");
