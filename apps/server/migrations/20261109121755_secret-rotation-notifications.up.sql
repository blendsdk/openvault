-- blendsdk-migration: 1
-- id: 20261109121755_secret-rotation-notifications
-- transaction: true
-- from-snapshot: c31c82d8be5b7bf5b4e6e6a0dad783df74c092beed3acaa48ea3c60dfeb3b2c1
-- to-snapshot: b1adb7c78e251192166de01eda1aad7c4cf599001397d3f200e765c5eb84a16f
CREATE TABLE "public"."secret_rotation_notifications" (
  "audit_event_id" text,
  "claim_id" text,
  "claimed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "days_until_due" integer NOT NULL,
  "due_at" timestamptz NOT NULL,
  "id" text NOT NULL,
  "project_id" text NOT NULL,
  "secret_id" text NOT NULL,
  "sent_at" timestamptz,
  "status" text NOT NULL,
  "version_id" text NOT NULL
);
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_349d6258df_check" CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$');
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_4ca1c67c7d_check" CHECK (status IN ('due_soon', 'overdue'));
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_audit_event_id_key" UNIQUE ("audit_event_id");
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_id_pkey" PRIMARY KEY ("id");
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_secret_id_version_id_s_55f86645f5" UNIQUE ("secret_id", "version_id", "status", "due_at");
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE "public"."secret_rotation_notifications" ADD CONSTRAINT "secret_rotation_notifications_secret_id_version_id_fkey" FOREIGN KEY ("secret_id", "version_id") REFERENCES "public"."secret_versions" ("secret_id", "id") ON UPDATE NO ACTION ON DELETE CASCADE;
CREATE INDEX "secret_rotation_notifications_status_idx" ON "public"."secret_rotation_notifications" ("sent_at", "claimed_at");
