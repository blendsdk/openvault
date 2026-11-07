-- blendsdk-migration: 1
-- id: 20261107011546_secret-consumer-summary-view
-- transaction: true
-- from-snapshot: 6806576fdf7e758415a6314cd8ba0dbd1a6e53be30375a4ef8a25cd80c2e10a5
-- to-snapshot: 8a4f61d333a55fe5a420ffb6cd63b216926f1dafef0306e6440bd81e8fd4242f
CREATE VIEW "public"."secret_consumer_summaries" AS
  SELECT s.id AS secret_id,
         s.project_id,
         c.compose_project,
         c.compose_service,
         c.last_seen
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
