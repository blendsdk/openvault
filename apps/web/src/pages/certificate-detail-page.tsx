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
const MAX_METADATA_PAGES = 20;

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
  const [loadedVersion, setLoadedVersion] = useState<string | undefined>(undefined);
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
  const [privateDeadline, setPrivateDeadline] = useState<number | undefined>(undefined);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS);
  const [privateFailure, setPrivateFailure] = useState<unknown>(undefined);
  const [now, setNow] = useState<number>(() => Date.now());
  const privateRegion = useRef<HTMLDivElement>(null);
  const privateInput = useRef<HTMLTextAreaElement>(null);
  const requestToken = useRef(0);

  const metadata = useAsync(
    async (signal) => {
      // The query matches the name or subject, so a busy project can place the
      // exact name on a later page. Follow the cursor until it is found.
      let cursor: string | undefined;
      for (let page = 0; page < MAX_METADATA_PAGES; page += 1) {
        const result = await client.certificates.listCertificates(
          {
            project: project.name,
            status,
            q: name,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          { signal },
        );
        const match = result.certificates.find((entry) => entry.name === name);
        if (match !== undefined) {
          return match;
        }
        if (result.nextCursor === null) {
          return undefined;
        }
        cursor = result.nextCursor;
      }
      return undefined;
    },
    [client, project.name, name, status],
  );

  const certificate: CertificateMetadata | undefined = deletedMetadata ?? metadata.data;

  const clearPrivate = useCallback((): void => {
    setPrivateKey(undefined);
    setPrivateDeadline(undefined);
    setSecondsLeft(REVEAL_SECONDS);
    setPrivateFailure(undefined);
  }, []);

  useEffect(() => {
    // The selected version belongs to the certificate that is displayed. A
    // reload with a different current version starts from the current version.
    void certificate?.version.id;
    requestToken.current += 1;
    setVersion("");
    setAppliedVersion("");
    setMaterial(undefined);
    setLoadedVersion(undefined);
    setPublicError(undefined);
    clearPrivate();
  }, [certificate?.version.id, clearPrivate]);

  useEffect(() => {
    if (metadata.data?.status === "deleted") {
      setDeletedMetadata(undefined);
    }
  }, [metadata.data?.status]);

  useEffect(() => {
    void name;
    void status;
    requestToken.current += 1;
    setVersion("");
    setAppliedVersion("");
    setMaterial(undefined);
    setLoadedVersion(undefined);
    setPublicError(undefined);
    clearPrivate();
  }, [name, status, clearPrivate]);

  useEffect(() => subscribeCredentialCopy((result) => setCopyStatus(result.message)), []);

  useEffect(() => {
    // A route change must never leave a revealed key in the page. Reading the
    // location values makes the dependency intent explicit to the linter.
    void location.pathname;
    void location.search;
    requestToken.current += 1;
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
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        clearPrivate();
      }
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Use an absolute deadline, not a countdown, so a throttled background
    // timer cannot extend the exposure window.
    const timer = setInterval(() => {
      if (privateDeadline === undefined) {
        return;
      }
      const remaining = privateDeadline - Date.now();
      if (remaining <= 0) {
        clearPrivate();
        return;
      }
      setSecondsLeft(Math.max(0, Math.ceil(remaining / 1_000)));
    }, 250);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(timer);
    };
  }, [privateKey, privateDeadline, clearPrivate]);

  useEffect(() => {
    if (privateKey !== undefined && secondsLeft === 0) {
      clearPrivate();
    }
  }, [privateKey, secondsLeft, clearPrivate]);

  useEffect(() => {
    if (certificate?.status !== "deleted" || certificate.purgeAfter === null) {
      return;
    }
    const remaining = Date.parse(certificate.purgeAfter) - now;
    if (remaining <= 0) {
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 50, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [certificate?.status, certificate?.purgeAfter, now]);

  useEffect(() => {
    const onFocus = (): void => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
    requestToken.current += 1;
    setAppliedVersion(version.trim());
    setMaterial(undefined);
    setLoadedVersion(undefined);
    setPublicError(undefined);
    clearPrivate();
  };

  const viewPublic = async (): Promise<void> => {
    if (certificate === undefined) {
      return;
    }
    const token = ++requestToken.current;
    setPublicLoading(true);
    setPublicError(undefined);
    setCopyStatus(undefined);
    try {
      const response = await client.certificates.getCertificate({
        project: project.name,
        name,
        version: effectiveVersion,
      });
      if (token !== requestToken.current) {
        return;
      }
      setMaterial({ certificatePem: response.certificatePem, chainPem: response.chainPem });
      setLoadedVersion(response.version.id);
    } catch (error) {
      if (token === requestToken.current) {
        setPublicError(error);
      }
    } finally {
      if (token === requestToken.current) {
        setPublicLoading(false);
      }
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
    Date.parse(certificate.purgeAfter) <= now;
  const purgeReason =
    certificate.status !== "deleted"
      ? "Delete the certificate before purging it."
      : certificate.purgeProtected
        ? "Purge protection is on and cannot be turned off."
        : certificate.purgeAfter === null
          ? "The retention deadline is not available."
          : Date.parse(certificate.purgeAfter) > now
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
      // Do not invent server lifecycle timestamps. The reload fills the real
      // deletedAt and purgeAfter values from the server.
      setDeletedMetadata({
        ...certificate,
        status: "deleted",
        deletedAt: null,
        purgeAfter: null,
      });
      setSearchParams({ status: "deleted" }, { replace: true });
      setMaterial(undefined);
      setLoadedVersion(undefined);
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
    const token = ++requestToken.current;
    setPrivateFailure(undefined);
    try {
      const response = await client.certificates.getCertificatePrivateKey({
        project: project.name,
        name,
        version: effectiveVersion,
      });
      if (token !== requestToken.current) {
        return;
      }
      setPrivateKey({ pem: response.privateKeyPem, versionId: response.version.id });
      setPrivateDeadline(Date.now() + REVEAL_SECONDS * 1_000);
      setSecondsLeft(REVEAL_SECONDS);
    } catch (error) {
      if (token === requestToken.current) {
        setPrivateFailure(error);
      }
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
                aria-describedby={
                  canPurge && purgeReason !== undefined ? "purge-reason" : undefined
                }
              >
                Purge
              </Button>
            ) : null}
          </>
        }
      />

      {actionFailure === undefined ? null : <CertificateErrorAlert error={actionFailure} />}
      {canPurge && purgeReason !== undefined ? (
        <p id="purge-reason" className="muted">
          {purgeReason}
        </p>
      ) : null}

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
                requestToken.current += 1;
                setVersion(data.value);
                setAppliedVersion("");
                setMaterial(undefined);
                setLoadedVersion(undefined);
                setPublicError(undefined);
                clearPrivate();
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
            Selected version <code>{effectiveVersion}</code>
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
                <p className="muted">
                  Loaded version <code>{loadedVersion ?? effectiveVersion}</code>
                </p>
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
              <p className="muted">
                Version <code>{privateKey.versionId}</code>
              </p>
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
