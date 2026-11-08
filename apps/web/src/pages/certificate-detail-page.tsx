import { Loading } from "@blendsdk/fluentui-react-components";
import { Button, Card, Field, Input, Text } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { CertificateGenerateDialog } from "../components/certificate-generate-dialog.js";
import { CertificateImportDialog } from "../components/certificate-import-dialog.js";
import { copyCredential, subscribeCredentialCopy } from "../components/credential-copy.js";
import { EmptyState, ErrorAlert } from "../components/feedback.js";
import { NavButton } from "../components/nav-button.js";
import { PageHeader } from "../components/page-header.js";
import { downloadPem } from "../components/pem.js";
import { formatTags, formatTime, StatusBadge } from "../components/status.js";
import type { OpenVaultWebClient } from "../generated/index.js";
import { useAsync } from "../hooks/use-async.js";
import { useProject } from "../projects/project-route.js";
import { useSessionApi } from "../session/session-api-provider.js";

type CertificateMetadata = Awaited<
  ReturnType<OpenVaultWebClient["certificates"]["listCertificates"]>
>["certificates"][number];

interface PublicMaterial {
  readonly certificatePem: string;
  readonly chainPem: string;
}

/**
 * Certificate detail with metadata, version selection, and public material.
 *
 * Metadata comes from the list route so active, expired, and deleted items all
 * load through one audited path. Public material is fetched only when the
 * operator asks for it, with a concrete version id so an expired current
 * certificate remains inspectable.
 */
export function CertificateDetailPage() {
  const { project } = useProject();
  const { name = "" } = useParams();
  const { client } = useSessionApi();
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") === "deleted" ? "deleted" : "active";
  const [version, setVersion] = useState("");
  const [appliedVersion, setAppliedVersion] = useState("");
  const [material, setMaterial] = useState<PublicMaterial | undefined>(undefined);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicError, setPublicError] = useState<unknown>(undefined);
  const [copyStatus, setCopyStatus] = useState<string | undefined>(undefined);
  const [renewMode, setRenewMode] = useState<"import" | "generate" | undefined>(undefined);

  const metadata = useAsync(
    async (signal) => {
      const page = await client.certificates.listCertificates(
        { project: project.name, status, q: name, limit: 100 },
        { signal },
      );
      return page.certificates.find((entry) => entry.name === name);
    },
    [client, project.name, name, status],
  );

  const certificate: CertificateMetadata | undefined = metadata.data;

  useEffect(() => {
    // The selected version belongs to the certificate that is displayed. A
    // reload with a different current version starts from the current version.
    void certificate?.version.id;
    setVersion("");
    setAppliedVersion("");
    setMaterial(undefined);
    setPublicError(undefined);
  }, [certificate?.version.id]);

  useEffect(() => subscribeCredentialCopy((result) => setCopyStatus(result.message)), []);

  const selectedVersion = appliedVersion.length > 0 ? appliedVersion : version.trim();
  const effectiveVersion =
    selectedVersion.length > 0 ? selectedVersion : (certificate?.version.id ?? "");

  const loadVersion = (): void => {
    setAppliedVersion(version.trim());
    setMaterial(undefined);
    setPublicError(undefined);
  };

  const viewPublic = async (): Promise<void> => {
    if (certificate === undefined) {
      return;
    }
    setPublicLoading(true);
    setPublicError(undefined);
    setCopyStatus(undefined);
    try {
      const response = await client.certificates.getCertificate({
        project: project.name,
        name,
        version: effectiveVersion,
      });
      setMaterial({ certificatePem: response.certificatePem, chainPem: response.chainPem });
    } catch (error) {
      setPublicError(error);
    } finally {
      setPublicLoading(false);
    }
  };

  const copyPublic = (text: string): void => {
    void copyCredential(text);
  };

  const base = `/projects/${encodeURIComponent(project.name)}/certificates`;

  if (metadata.loading) {
    return (
      <div className="page-loading" aria-busy="true">
        <Loading label="Loading certificate…" />
      </div>
    );
  }
  if (metadata.error !== undefined) {
    return (
      <section className="page">
        <ErrorAlert error={metadata.error} onRetry={metadata.reload} />
      </section>
    );
  }
  if (certificate === undefined) {
    return (
      <section className="page">
        <EmptyState
          title="Certificate not found"
          action={
            <NavButton to={base} appearance="primary">
              Back to certificates
            </NavButton>
          }
        >
          <p>
            No certificate named <code>{name}</code> is visible in this project.
          </p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page stack-lg">
      <PageHeader
        eyebrow={
          <>
            <Link to={base}>Certificates</Link> <span aria-hidden="true">/</span> {certificate.name}
          </>
        }
        title={certificate.name}
        description={
          <span className="muted">
            <StatusBadge status={certificate.status} /> · updated{" "}
            {formatTime(certificate.updatedAt)}
          </span>
        }
        actions={
          certificate.capabilities.canWrite && certificate.status !== "deleted" ? (
            <>
              <Button appearance="secondary" onClick={() => setRenewMode("import")}>
                Import new version
              </Button>
              <Button appearance="secondary" onClick={() => setRenewMode("generate")}>
                Generate new version
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="detail-grid">
        <Card>
          <Text weight="semibold">Metadata</Text>
          <dl className="metadata-list">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={certificate.status} />
            </dd>
            <dt>Subject</dt>
            <dd>{certificate.subject}</dd>
            <dt>SANs</dt>
            <dd>{certificate.sans.length === 0 ? "—" : certificate.sans.join(", ")}</dd>
            <dt>Issuer</dt>
            <dd>{certificate.issuer}</dd>
            <dt>Serial</dt>
            <dd>
              <code>{certificate.serial}</code>
            </dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{certificate.fingerprint}</code>
            </dd>
            <dt>Version id</dt>
            <dd>
              <code>{certificate.version.id}</code>
            </dd>
            <dt>Not before</dt>
            <dd>{formatTime(certificate.notBefore)}</dd>
            <dt>Not after</dt>
            <dd>{formatTime(certificate.notAfter)}</dd>
            <dt>Days to expiry</dt>
            <dd>{certificate.daysToExpiry}</dd>
            <dt>Chain length</dt>
            <dd>{certificate.chainLength}</dd>
            <dt>Tags</dt>
            <dd>{formatTags(certificate.tags)}</dd>
            <dt>Created</dt>
            <dd>{formatTime(certificate.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatTime(certificate.updatedAt)}</dd>
            <dt>Deleted at</dt>
            <dd>{formatTime(certificate.deletedAt)}</dd>
            <dt>Purge after</dt>
            <dd>{formatTime(certificate.purgeAfter)}</dd>
            <dt>Purge protected</dt>
            <dd>{certificate.purgeProtected ? "Enabled" : "Disabled"}</dd>
          </dl>
        </Card>

        <Card>
          <Text weight="semibold">Version</Text>
          <Field label="Version" hint="Empty means the current version">
            <Input
              value={version}
              onChange={(_event, data) => {
                setVersion(data.value);
                setAppliedVersion("");
              }}
              placeholder={certificate.version.id}
            />
          </Field>
          <div className="row-actions">
            <Button appearance="secondary" onClick={loadVersion}>
              Load version
            </Button>
          </div>
          <p className="muted">
            Reading version <code>{effectiveVersion}</code>
          </p>
        </Card>
      </div>

      <Card>
        <Text weight="semibold">Public material</Text>
        {certificate.status === "deleted" ? (
          <p className="muted">Public material is unavailable for a deleted certificate.</p>
        ) : certificate.capabilities.canRead ? (
          <>
            <div className="row-actions">
              <Button
                appearance="primary"
                onClick={() => void viewPublic()}
                disabled={publicLoading}
              >
                {publicLoading ? "Loading…" : "View public certificate"}
              </Button>
            </div>
            {publicError === undefined ? null : <ErrorAlert error={publicError} />}
            {material === undefined ? null : (
              <div className="stack">
                <label htmlFor="certificate-leaf-pem">Leaf certificate</label>
                <textarea
                  id="certificate-leaf-pem"
                  aria-label="Leaf certificate"
                  className="revealed-value"
                  readOnly
                  rows={8}
                  value={material.certificatePem}
                />
                <div className="row-actions">
                  <Button
                    appearance="secondary"
                    onClick={() => copyPublic(material.certificatePem)}
                  >
                    Copy leaf
                  </Button>
                  <Button
                    appearance="subtle"
                    onClick={() =>
                      downloadPem(`${certificate.name}-certificate.pem`, material.certificatePem)
                    }
                  >
                    Download leaf
                  </Button>
                </div>
                {material.chainPem.length === 0 ? (
                  <p className="muted">No intermediate chain</p>
                ) : (
                  <>
                    <label htmlFor="certificate-chain-pem">Intermediate chain</label>
                    <textarea
                      id="certificate-chain-pem"
                      aria-label="Intermediate chain"
                      className="revealed-value"
                      readOnly
                      rows={8}
                      value={material.chainPem}
                    />
                    <div className="row-actions">
                      <Button appearance="secondary" onClick={() => copyPublic(material.chainPem)}>
                        Copy chain
                      </Button>
                      <Button
                        appearance="subtle"
                        onClick={() =>
                          downloadPem(`${certificate.name}-chain.pem`, material.chainPem)
                        }
                      >
                        Download chain
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
            {copyStatus === undefined ? null : (
              <p className="muted" role="status">
                {copyStatus}
              </p>
            )}
          </>
        ) : (
          <p className="muted">You do not have permission to read the public certificate.</p>
        )}
      </Card>

      <CertificateImportDialog
        open={renewMode === "import"}
        project={project.name}
        renew={{ name: certificate.name, versionId: certificate.version.id }}
        onClose={() => setRenewMode(undefined)}
        onSaved={metadata.reload}
      />
      <CertificateGenerateDialog
        open={renewMode === "generate"}
        project={project.name}
        renew={{ name: certificate.name, versionId: certificate.version.id }}
        onClose={() => setRenewMode(undefined)}
        onSaved={metadata.reload}
      />
    </section>
  );
}
