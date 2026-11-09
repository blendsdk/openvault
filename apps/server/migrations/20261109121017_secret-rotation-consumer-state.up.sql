-- blendsdk-migration: 1
-- id: 20261109121017_secret-rotation-consumer-state
-- transaction: true
-- from-snapshot: 632156d6288f687bfacc75ecf5de2af91551fcbef25b0cd8e00b5356d627aa38
-- to-snapshot: c31c82d8be5b7bf5b4e6e6a0dad783df74c092beed3acaa48ea3c60dfeb3b2c1
CREATE OR REPLACE VIEW "public"."secret_consumer_summaries" AS
  SELECT s.id AS secret_id,
         s.project_id,
         c.compose_project,
         c.compose_service,
         c.last_seen,
         c.state
    FROM secrets s
    JOIN consumers c ON c.project_id = s.project_id
    JOIN principals p ON p.id = c.principal_id AND p.status = 'active'
   WHERE EXISTS (
     SELECT 1
       FROM role_assignments r
      WHERE r.principal_id = c.principal_id
        AND r.role IN ('org.admin', 'project.admin', 'secrets.manager',
                       'secrets.officer', 'secrets.reader')
        AND (r.expires_at IS NULL OR r.expires_at > now())
        AND (
          r.scope_type = 'org'
          OR (r.scope_type = 'project' AND r.scope_id = s.project_id)
          OR (r.scope_type = 'object' AND r.scope_id = s.id AND r.role = 'secrets.reader')
        )
   )
;
