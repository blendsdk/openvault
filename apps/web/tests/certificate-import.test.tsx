import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CertificateImportDialog } from "../src/components/certificate-import-dialog.js";
import {
  FakeVault,
  TEST_CERTIFICATE_PEM,
  TEST_CHAIN_PEM,
  TEST_PRIVATE_KEY_PEM,
} from "./helpers/fake-vault.js";
import { renderPage } from "./helpers/render.js";

function renderImport(vault: FakeVault, callbacks: { onSaved?: () => void } = {}) {
  return renderPage(
    <CertificateImportDialog
      open
      project="payments"
      onClose={vi.fn()}
      onSaved={callbacks.onSaved ?? vi.fn()}
    />,
    { vault, path: "/projects/payments/certificates" },
  );
}

function importRequest(vault: FakeVault) {
  return vault.requests.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/data/payments/certificates/import",
  );
}

async function fillImportForm(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Certificate name/), {
    target: { value: "imported-tls" },
  });
  fireEvent.change(screen.getByLabelText(/Leaf certificate PEM/), {
    target: { value: TEST_CERTIFICATE_PEM },
  });
  fireEvent.change(screen.getByLabelText("Chain PEM"), {
    target: { value: TEST_CHAIN_PEM },
  });
  fireEvent.change(screen.getByLabelText(/Private key PEM/), {
    target: { value: TEST_PRIVATE_KEY_PEM },
  });
  fireEvent.change(screen.getByLabelText("Tags"), {
    target: { value: "env=test" },
  });
  fireEvent.click(screen.getByLabelText("Allow a certificate that is not yet valid"));
}

describe("certificate import", () => {
  it("should send the leaf, chain, key, tags, and allow-not-yet-valid flag", async () => {
    const vault = new FakeVault();
    const onSaved = vi.fn();
    renderImport(vault, { onSaved });
    expect(screen.getByText(/adds a new version/)).toBeInTheDocument();
    await fillImportForm();
    fireEvent.click(screen.getByRole("button", { name: "Import certificate" }));

    await waitFor(() => expect(importRequest(vault)).toBeDefined());
    expect(importRequest(vault)?.body).toMatchObject({
      name: "imported-tls",
      certificatePem: TEST_CERTIFICATE_PEM,
      chainPem: TEST_CHAIN_PEM,
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      tags: { env: "test" },
      allowNotYetValid: true,
    });
    expect(vault.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    expect(await screen.findByText(/is ready/)).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("should fill the leaf field from a local file without an upload request", async () => {
    const vault = new FakeVault();
    renderImport(vault);
    const input = await screen.findByLabelText("Leaf certificate file");
    const file = new File([TEST_CERTIFICATE_PEM], "leaf.pem", {
      type: "application/x-pem-file",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByLabelText(/Leaf certificate PEM/)).toHaveValue(TEST_CERTIFICATE_PEM);
    });
    expect(vault.requests.filter((entry) => entry.method === "POST")).toHaveLength(0);
  });

  it("should show the version and every warning before closing", async () => {
    const vault = new FakeVault();
    vault.certificateWarnings = [
      { code: "expired", message: "The certificate is already expired." },
    ];
    renderImport(vault);
    await fillImportForm();
    fireEvent.click(screen.getByRole("button", { name: "Import certificate" }));

    expect(await screen.findByText("The certificate is already expired.")).toBeInTheDocument();
    expect(screen.getByText(/is ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open certificate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("should keep the form open and show the access-denied message on a denied write", async () => {
    const vault = new FakeVault();
    vault.failCertificate = {
      status: 403,
      code: "access_denied",
      message: "Access denied",
    };
    renderImport(vault);
    await fillImportForm();
    fireEvent.click(screen.getByRole("button", { name: "Import certificate" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Access denied");
    expect(screen.getByLabelText(/Certificate name/)).toBeInTheDocument();
    expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
  });
});
