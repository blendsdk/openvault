import { Loading, useConfirm } from "@blendsdk/fluentui-react-components";
import { Button, Card, Field, Input, Text } from "@fluentui/react-components";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { CertificateErrorAlert } from "../components/certificate-errors.js";
import { CertificateGenerateDialog } from "../components/certificate-generate-dialog.js";
import { CertificateImportDialog } from "../components/certificate-import-dialog.js";
import { CertificateMetadataDialog } from "../components/certificate-metadata-dialog.js";
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

interface RevealedPrivateKey {
  readonly pem: string;
  readonly versionId: string;
}

const REVEAL_SECONDS = 60;
const RETENTION_WINDOW_MS = 30 * 86_400_000;

/**
 * Certificate detail with metadata, version selection, public material, the
 * lifecycle actions, and the audited private-key reveal.
 *
 * Metadata comes from the list route so active, expired, and deleted items all
 * load through one audited path. Every read and write is still authorized by
 * the server; the capability flags only hide actions the caller cannot use.
 */
export function CertificateDetailPage() {
  const { project } = useProject();
  const { name = "" } = useParams();
  const { client } = useSessionApi();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") === "deleted" ? "deleted" : "active";
  const [version, setVersion] = useState("");
  const [appliedVersion, setAppliedVersion] = useState("");
  const [material, setMaterial] = useState<PublicMaterial | undefined>(undefined);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicError, setPublicError] = useState<unknown>(undefined);
  const [copyStatus, setCopyStatus] = useState<string | undefined>(undefined);
  const [renewMode, setRenewMode] = useState<"import" | "generate" | undefined>(undefined);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [deletedMetadata, setDeletedMetadata] = useState<CertificateMetadata | undefined>(
    undefined,
  );
  const [actionFailure, setActionFailure] = useState<unknown>(undefined);
  const [privateKey, setPrivateKey] = useState<RevealedPrivateKey | undefined>(undefined);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS);
  const [privateFailure, setPrivateFailure] = useState<unknown>(undefined);
  const privateRegion = useRef<HTMLDivElement>(null);
  const privateInput = useRef<HTMLTextAreaElement>(null);

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

  const certificate: CertificateMetadata | undefined = deletedMetadata ?? metadata.data;

  const clearPrivate = useCallback((): void => {
    setPrivateKey(undefined);
    setSecondsLeft(REVEAL_SECONDS);
    setPrivateFailure(undefined);
  }, []);

  useEffect(() => {
    // The selected version belongs to the certificate that is displayed. A
    // reload with a different current version starts from the current version.
    void certificate?.version.id;
    setVersion("");
    setAppliedVersion("");
    setMaterial(undefined);
    setPublicError(undefined);
  }, [certificate?.version.id]);

  useEffect(() => {
    if (metadata.data?.status === "deleted") {
      setDeletedMetadata(undefined);
    }
  }, [metadata.data?.status]);

  useEffect(() => subscribeCredentialCopy((result) => setCopyStatus(result.message)), []);

  useEffect(() => {
    // A route change must never leave a revealed key in the page. Reading the
    // location values makes the dependency intent explicit to the linter.
    void location.pathname;
    void location.search;
    clearPrivate();
  }, [location.pathname, location.search, clearPrivate]);

  useEffect(() => {
    if (privateKey === undefined) {
      return;
    }
    if (privateInput.current !== null) {
      privateInput.current.focus();
    }
    const onWindowBlur = (): void => clearPrivate();
    window.addEventListener("blur", onWindowBlur);
    const timer = setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      clearInterval(timer);
    };
  }, [privateKey, clearPrivate]);

  useEffect(() => {
    if (privateKey !== undefined && secondsLeft === 0) {
      clearPrivate();
    }
  }, [privateKey, secondsLeft, clearPrivate]);

  useEffect(() => {
    const region = privateRegion.current;
    if (region === null || privateKey === undefined) {
      return;
    }
    const onBlur = (event: FocusEvent): void => {
      if (!region.contains(event.relatedTarget as Node | null)) {
        clearPrivate();
      }
    };
    region.addEventListener("blur", onBlur, true);
    return () => region.removeEventListener("blur", onBlur, true);
  }, [privateKey, clearPrivate]);

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

  const canWrite = certificate.capabilities.canWrite;
  const canDelete = certificate.capabilities.canDelete;
  const canRecover = certificate.capabilities.canRecover;
  const canPurge = certificate.capabilities.canPurge;
  const canReadPrivate = certificate.capabilities.canReadPrivate;
  const notDeleted = certificate.status !== "deleted";
  const purgeReady =
    certificate.status === "deleted" &&
    !certificate.purgeProtected &&
    certificate.purgeAfter !== null &&
    Date.parse(certificate.purgeAfter) <= Date.now();
  const purgeReason =
    certificate.status !== "deleted"
      ? "Delete the certificate before purging it."
      : certificate.purgeProtected
        ? "Purge protection is on and cannot be turned off."
        : certificate.purgeAfter === null
          ? "The retention deadline is not available."
          : Date.parse(certificate.purgeAfter) > Date.now()
            ? `Purge is available after ${formatTime(certificate.purgeAfter)}.`
            : undefined;

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete certificate ${certificate.name}?`,
      message: "The certificate is soft-deleted and can be recovered until its purge deadline.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setActionFailure(undefined);
    try {
      await client.certificates.deleteCertificate({ project: project.name, name });
      const now = new Date();
      setDeletedMetadata({
        ...certificate,
        status: "deleted",
        deletedAt: now.toISOString(),
        purgeAfter: new Date(now.getTime() + RETENTION_WINDOW_MS).toISOString(),
      });
      setSearchParams({ status: "deleted" }, { replace: true });
      setMaterial(undefined);
      clearPrivate();
    } catch (error) {
      setActionFailure(error);
    }
  };

  const recover = async (): Promise<void> => {
    setActionFailure(undefined);
    try {
      await client.certificates.recoverCertificate({ project: project.name, name });
      setDeletedMetadata(undefined);
      setSearchParams({ status: "active" }, { replace: true });
      metadata.reload();
    } catch (error) {
      setActionFailure(error);
    }
  };

  const purge = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Permanently purge ${certificate.name}?`,
      message: "This cannot be undone. Every version and its wrapped key are removed.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setActionFailure(undefined);
    try {
      await client.certificates.purgeCertificate({ project: project.name, name });
      navigate(base, { replace: true });
    } catch (error) {
      setActionFailure(error);
    }
  };

  const revealPrivate = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Reveal the private key for ${certificate.name}?`,
      message:
        "This read is audited. The key is hidden after 60 seconds and is never copied automatically.",
      intent: "danger",
    });
    if (!confirmed) {
      return;
    }
    setPrivateFailure(undefined);
    try {
      const response = await client.certificates.getCertificatePrivateKey({
        project: project.name,
        name,
        version: effectiveVersion,
      });
      setPrivateKey({ pem: response.privateKeyPem, versionId: response.version.id });
      setSecondsLeft(REVEAL_SECONDS);
    } catch (error) {
      setPrivateFailure(error);
    }
  };

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
          <>
            {canReadPrivate && notDeleted ? (
              <Button appearance="secondary" onClick={() => void revealPrivate()}>
                View private key
              </Button>
            ) : null}
            {canWrite && notDeleted ? (
              <Button appearance="secondary" onClick={() => setMetadataOpen(true)}>
                Edit metadata
              </Button>
            ) : null}
            {canWrite && notDeleted ? (
              <>
                <Button appearance="secondary" onClick={() => setRenewMode("import")}>
                  Import new version
                </Button>
                <Button appearance="secondary" onClick={() => setRenewMode("generate")}>
                  Generate new version
                </Button>
              </>
            ) : null}
            {canDelete && notDeleted ? (
              <Button appearance="subtle" onClick={() => void remove()}>
                Delete
              </Button>
            ) : null}
            {canRecover && !notDeleted ? (
              <Button appearance="secondary" onClick={() => void recover()}>
                Recover
              </Button>
            ) : null}
            {canPurge ? (
              <Button
                appearance="subtle"
                onClick={() => void purge()}
                disabled={!purgeReady}
                aria-describedby={purgeReason === undefined ? undefined : "purge-reason"}
              >
                Purge
              </Button>
            ) : null}
          </>
        }
      />

      {actionFailure === undefined ? null : <CertificateErrorAlert error={actionFailure} />}
      {purgeReason === undefined ? null : (
        <p id="purge-reason" className="muted">
          {purgeReason}
        </p>
      )}

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
            {publicError === undefined ? null : <CertificateErrorAlert error={publicError} />}
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

      {canReadPrivate && notDeleted ? (
        <Card>
          <Text weight="semibold">Private key</Text>
          {privateKey === undefined ? (
            <p className="muted">
              The key is masked until an explicit, audited reveal. It is hidden after 60 seconds and
              is never copied automatically.
            </p>
          ) : (
            <div className="revealed-region" ref={privateRegion}>
              <textarea
                aria-label="Private key"
                className="revealed-value"
                ref={privateInput}
                readOnly
                rows={8}
                value={privateKey.pem}
                onBlur={(event) => {
                  if (!privateRegion.current?.contains(event.relatedTarget as Node | null)) {
                    clearPrivate();
                  }
                }}
              />
              <div className="row-actions">
                <Button
                  appearance="secondary"
                  onClick={() =>
                    downloadPem(
                      `${certificate.name}-${privateKey.versionId}.key.pem`,
                      privateKey.pem,
                    )
                  }
                >
                  Download private key
                </Button>
                <Button appearance="subtle" onClick={clearPrivate}>
                  Hide now
                </Button>
                <span className="muted" aria-live="polite">
                  Clears in {secondsLeft}s
                </span>
              </div>
            </div>
          )}
          {privateFailure === undefined ? null : <CertificateErrorAlert error={privateFailure} />}
        </Card>
      ) : null}

      <CertificateMetadataDialog
        open={metadataOpen}
        project={project.name}
        certificate={certificate}
        onClose={() => setMetadataOpen(false)}
        onSaved={metadata.reload}
      />
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
