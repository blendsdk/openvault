# Container images

| File | Image | Runtime user | Entry point |
|---|---|---|---|
| `server.Dockerfile` | `openvault` | 10001 | `node /app/server/dist/main.js` |
| `agent.Dockerfile` | `openvault-agent` | 10001 | `/usr/local/bin/ov-agent` |
| `web.Dockerfile` | `openvault-web` | 101 (nginx) | nginx on 8080 |

Build from the repository root:

```bash
docker build -f deploy/docker/server.Dockerfile -t openvault:local .
docker build -f deploy/docker/agent.Dockerfile -t openvault-agent:local .
docker build -f deploy/docker/web.Dockerfile -t openvault-web:local .
```

The server image also contains the `ov` CLI and the built SPA. The reference Compose stack runs
the SPA from the separate web image, but a single-container deployment can serve it from the
API image.

All three images run as non-root. The release workflow builds them for `linux/amd64`, scans
them with Trivy, signs them with Cosign keyless, and publishes an SBOM and provenance
attestation. See [Release process](/security/release-process).
