# Known limitations

These are the limitations that matter when you operate OpenVault.

| Area | Limitation |
|---|---|
| Deployment | One host, one organization. There is no high availability or multi-region mode. |
| Recovery | Recovery point objective is 24 hours with daily encrypted backups; recovery time objective is about one hour. The schedule is operator-managed. |
| Host root | Root on the vault host can read the keyring, the agent temporary files, and plaintext in memory. Use a dedicated host. |
| Swap | The shared temporary filesystem can be swapped. Disable swap or use encrypted swap. |
| Application compromise | Any secret delivered to a container can be read by code in that container. OpenVault limits the blast radius but cannot make a compromised workload safe. |
| Environment variables | Environment injection is set at application startup. A running process does not see a rotated value until it restarts. Values also leak through process inspection and crash dumps; prefer file delivery. |
| Browser sessions | Sessions live in memory. A server restart signs browser users out. |
| Certificates | OpenVault is not a public certificate authority. Certificate management is available through the API, CLI, and web UI. Certificate version history is not listed in the UI; read the current version or a known version id. |
| Remote hosts | Agents must run on the same Docker host as the vault. |
| Project deletion | A deleted project and its secrets are hidden, not recoverable from the UI. Restore from backup is the recovery path. |
| CA rotation | There is no online CA rotation command. A suspected CA compromise requires a fresh deployment and new identities. |
| Kubernetes and external key services | Kubernetes identity, external KMS/HSM, and ACME are not part of this release. |
