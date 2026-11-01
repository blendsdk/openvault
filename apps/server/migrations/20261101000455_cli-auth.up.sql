-- blendsdk-migration: 1
-- id: 20261101000455_cli-auth
-- transaction: true
-- from-snapshot: dcbd59d6b606aa4e35d54b3776cba9007c32557815a556c206754780ba4a8d17
-- to-snapshot: aad0caf02c16e7c3612e741ff1a6ecaec800db54d33d879c333169fce50a7fb3
CREATE TABLE "public"."signing_keys" (
  "activated_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "kek_id" text NOT NULL,
  "kid" text NOT NULL,
  "public_key" bytea NOT NULL,
  "retired_at" timestamptz,
  "status" text NOT NULL,
  "wrap_nonce" bytea NOT NULL,
  "wrap_tag" bytea NOT NULL,
  "wrapped_seed" bytea NOT NULL
);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_29581f1676_check" CHECK (octet_length(wrap_nonce) = 12);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_3f0173faeb_check" CHECK (kid ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_635db7c450_check" CHECK (status IN ('current', 'previous', 'retired'));
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_7967c4a0d1_check" CHECK ((status = 'retired' AND retired_at IS NOT NULL) OR (status <> 'retired' AND retired_at IS NULL));
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_9878f8ddc0_check" CHECK (octet_length(wrap_tag) = 16);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_9f29a981a8_check" CHECK (octet_length(public_key) = 32);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_a9e2e02429_check" CHECK (length(kek_id) BETWEEN 1 AND 64);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_e05e560267_check" CHECK (octet_length(wrapped_seed) = 32);
ALTER TABLE "public"."signing_keys" ADD CONSTRAINT "signing_keys_kid_pkey" PRIMARY KEY ("kid");
CREATE INDEX "cli_sessions_cleanup_idx" ON "public"."cli_sessions" (GREATEST(expires_at, COALESCE(revoked_at, expires_at)));
CREATE UNIQUE INDEX "cli_sessions_family_live_idx" ON "public"."cli_sessions" ("family_id") WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX "signing_keys_current_idx" ON "public"."signing_keys" ("status") WHERE status = 'current';
CREATE UNIQUE INDEX "signing_keys_previous_idx" ON "public"."signing_keys" ("status") WHERE status = 'previous';
