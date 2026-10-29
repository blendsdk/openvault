# Troubleshooting

## The agent is unhealthy

Check the agent logs and `ov-agent health`:

1. Is `OPENVAULT_JOIN_TOKEN` set for the first boot?
2. Does the agent trust the server certificate (`OPENVAULT_CA_FILE`)?
3. Is the agent attached to `vault_net`?
4. Has the join token expired or already been used?

If the certificate is revoked, the agent removes its files and exits. Issue a new join
token and restart it.

## The application cannot read a file

- The agent and application must use the same UID.
- The file mode is `0400`; a different UID cannot read it.
- The application mounts the directory read-only at the same path.
- The agent must be healthy before the application starts; check `depends_on`.

## Permission denied

- Check the assignment: `ov access explain <secret> --project <project>`.
- Service identities cannot hold control-plane actions.
- Object-scope assignments only cover one object.
- A revocation takes effect within 5 seconds.

## OIDC login fails

- Verify `OPENVAULT_BASE_URL`, issuer, client id, and client secret.
- The redirect URI must be `${OPENVAULT_BASE_URL}/v1/auth/callback`.
- Check clock synchronization. Token validation allows 30 seconds of skew.
- Check `/v1/meta/auth`; if `oidc` is false, the server did not load the configuration.

## The UI is blank or assets 404

The production build must be served under the configured base path. The default GitHub
Pages base is `/openvault/`; a custom domain uses `/`. Rebuild after changing it.

## Database is unavailable

`/ready` fails and agents run with the last known good values, marked degraded. Restore
PostgreSQL before rotating secrets.

## Audit verification fails

`ov audit verify` reports the first broken event id. Do not repair rows manually. Export
the range and investigate the host and database access. A checkpoint is the only trusted
anchor after pruning.

## Still stuck?

Open an issue with the version, reproduction steps, and redacted logs. Never include
secrets or private keys.
