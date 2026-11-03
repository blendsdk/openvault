-- blendsdk-migration: 1
-- id: 20261103192657_rbac-policy-state
-- transaction: true
-- from-snapshot: 329526d411d3af98bb252caa1c069b031455ff36b40f2af6a1bf115c7090e199
-- to-snapshot: 095154c7eb139c9b071d34bd2cf95480d345a43f0574aab7b3921418378c7e24
CREATE TABLE "public"."policy_state" (
  "id" smallint DEFAULT 1 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL
);
ALTER TABLE "public"."policy_state" ADD CONSTRAINT "policy_state_429634fbaa_check" CHECK (version > 0);
ALTER TABLE "public"."policy_state" ADD CONSTRAINT "policy_state_cec3cc2294_check" CHECK (id = 1);
ALTER TABLE "public"."policy_state" ADD CONSTRAINT "policy_state_id_pkey" PRIMARY KEY ("id");
