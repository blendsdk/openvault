-- blendsdk-migration: 1
-- id: 20261103192700_policy-state-seed
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none

INSERT INTO policy_state (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
