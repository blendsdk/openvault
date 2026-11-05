-- blendsdk-migration: 1
-- id: 20261104215532_certificate-expiry
-- transaction: true
-- from-snapshot: 095154c7eb139c9b071d34bd2cf95480d345a43f0574aab7b3921418378c7e24
-- to-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c
CREATE TABLE "public"."certificate_expiry_notifications" (
  "audit_event_id" text NOT NULL,
  "certificate_id" text NOT NULL,
  "claimed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "days_to_expiry" integer NOT NULL,
  "id" bigserial NOT NULL,
  "sent_at" timestamptz,
  "status" text DEFAULT 'pending' NOT NULL,
  "threshold_days" integer NOT NULL,
  "version_id" text NOT NULL
);
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_1acb232561_check" CHECK (threshold_days IN (7, 14, 30));
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_202ed8bb93_check" CHECK (audit_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_6d5150f441_check" CHECK (status IN ('pending', 'sent'));
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_955967eba9_check" CHECK (days_to_expiry BETWEEN 0 AND 30);
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_audit_event_id_key" UNIQUE ("audit_event_id");
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_version_id_threshold_days_key" UNIQUE ("version_id", "threshold_days");
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."certificate_expiry_notifications" ADD CONSTRAINT "certificate_expiry_notifications_certificate_id_version_id_fkey" FOREIGN KEY ("certificate_id", "version_id") REFERENCES "public"."certificate_versions" ("certificate_id", "id") ON UPDATE NO ACTION ON DELETE CASCADE;
CREATE INDEX "certificate_expiry_notifications_certificate_idx" ON "public"."certificate_expiry_notifications" ("certificate_id");
CREATE INDEX "certificate_expiry_notifications_status_idx" ON "public"."certificate_expiry_notifications" ("status", "created_at");
CREATE INDEX "certificate_versions_not_after_idx" ON "public"."certificate_versions" ("not_after");
