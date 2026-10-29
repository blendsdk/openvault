# Certificates

::: warning Target documentation
Certificate APIs and CLI commands are part of v0.1. Certificate screens are v0.2.
:::

OpenVault stores certificate chains and private keys with the same envelope encryption as
secrets. It can also generate self-signed certificates.

## Import

```bash
ov cert import tls-server \
  --project payments \
  --cert ./server.crt \
  --chain ./intermediate.crt \
  --key ./server.key
```

- The key must be PKCS#8.
- RSA and EC keys are supported.
- The public key in the certificate must match the private key.
- Expired certificates import with a warning.
- Not-yet-valid certificates are rejected unless `--allow-not-yet-valid` is set.

## Generate

```bash
ov cert generate tls-server \
  --project payments \
  --subject "CN=payments.internal" \
  --san "DNS:payments.internal,DNS:api.payments.internal" \
  --key-type ec-p256
```

Supported: RSA 2048/3072 and EC P-256.

## Read

`certificate.read` returns the public chain. The private key requires
`certificate.read_private` and produces a sensitive audit event.

```bash
ov cert get tls-server --project payments
ov cert get tls-server --project payments --private
```

## Expiry

A daily job records days-to-expiry. Warnings are logged and sent to the configured webhook
at 30, 14, and 7 days.

## Lifecycle

Certificates support immutable versions, soft delete, recovery, and opt-in purge
protection, matching secrets.

## Next

- [Rotation](/guide/rotation)
- [Audit](/guide/audit)
