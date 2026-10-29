-- Request replay protection for mutating HTTP operations.

CREATE TABLE idempotency_keys (
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  method text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  resource_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
