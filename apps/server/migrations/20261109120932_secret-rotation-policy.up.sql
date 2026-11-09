-- blendsdk-migration: 1
-- id: 20261109120932_secret-rotation-policy
-- transaction: true
-- from-snapshot: 8a4f61d333a55fe5a420ffb6cd63b216926f1dafef0306e6440bd81e8fd4242f
-- to-snapshot: 632156d6288f687bfacc75ecf5de2af91551fcbef25b0cd8e00b5356d627aa38
ALTER TABLE "public"."secrets" ADD COLUMN "rotation_interval_days" integer;
ALTER TABLE "public"."secrets" ADD CONSTRAINT "secrets_9195b03144_check" CHECK (rotation_interval_days BETWEEN 1 AND 3650);
CREATE INDEX "secrets_rotation_idx" ON "public"."secrets" ("rotation_interval_days") WHERE rotation_interval_days IS NOT NULL;
