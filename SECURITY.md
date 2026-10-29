# Security Policy

## Supported versions

OpenVault is in early development. Security fixes are applied to the `main` branch. Once
v0.1 is released, the latest minor release will receive security fixes.

| Version | Supported |
|---|---|
| `main` | Yes |
| Pre-release tags | Best effort |

## Reporting a vulnerability

Do **not** open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting:

1. Open <https://github.com/blendsdk/openvault/security/advisories/new>.
2. Include the affected version or commit, a description, reproduction steps, and the
   impact you believe is possible.
3. If you cannot use GitHub, email the maintainers listed in the repository profile.

We aim to acknowledge reports within 3 business days and to provide an initial assessment
within 7 business days. Please allow time for a fix before public disclosure.

## Scope

In scope:

- secret or certificate disclosure
- authentication or authorization bypass
- audit log tampering
- agent or tmpfs isolation bypass
- cryptographic misuse
- remote code execution or injection

Out of scope:

- attacks requiring root on the vault host
- attacks requiring the KEK file or its passphrase
- denial of service against a single-node development deployment
- findings in dependencies without a demonstrated impact

## Handling secrets in reports

Never include a real secret, private key, token, or production hostname in a report. Use
synthetic values and redact logs. If a real secret may have leaked, rotate it first.

## Security updates

Fixes are announced in the GitHub release notes and the documentation changelog. Critical
fixes may be released without a public pre-announcement.
