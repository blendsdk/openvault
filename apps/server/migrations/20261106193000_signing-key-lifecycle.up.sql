-- blendsdk-migration: 1
-- id: 20261106193000_signing-key-lifecycle
-- transaction: true
-- from-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c
-- to-snapshot: 13a0d9e357fc9afdfb25968443c71492551dbac433f58f2b5782864e8328d30c

-- Protect signing-key material and lifecycle transitions from direct database writes.
--
-- The runtime role can insert a signing-key row for rotation, but it must not be
-- able to replace key material, move timestamps, or resurrect an old status.
-- Only the two legitimate transitions are allowed:
--   current -> previous (retired_at still null)
--   previous -> retired (retired_at set)

CREATE OR REPLACE FUNCTION signing_keys_guard_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kid IS DISTINCT FROM OLD.kid
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.wrapped_seed IS DISTINCT FROM OLD.wrapped_seed
     OR NEW.wrap_nonce IS DISTINCT FROM OLD.wrap_nonce
     OR NEW.wrap_tag IS DISTINCT FROM OLD.wrap_tag
     OR NEW.kek_id IS DISTINCT FROM OLD.kek_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'signing key material and lifecycle timestamps are immutable';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'current' AND NEW.status = 'previous' AND NEW.retired_at IS NULL)
      OR (OLD.status = 'previous' AND NEW.status = 'retired' AND NEW.retired_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'invalid signing key status transition';
    END IF;
  ELSIF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'retired_at cannot change without a status transition';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signing_keys_guard_lifecycle ON signing_keys;
CREATE TRIGGER signing_keys_guard_lifecycle
BEFORE UPDATE ON signing_keys
FOR EACH ROW EXECUTE FUNCTION signing_keys_guard_lifecycle();
