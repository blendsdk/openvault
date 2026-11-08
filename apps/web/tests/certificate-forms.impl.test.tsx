import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CertificateGenerateDialog } from "../src/components/certificate-generate-dialog.js";
import { CertificateImportDialog } from "../src/components/certificate-import-dialog.js";
import { FakeVault, TEST_CERTIFICATE_PEM, TEST_PRIVATE_KEY_PEM } from "./helpers/fake-vault.js";
import { renderPage } from "./helpers/render.js";

function renderImport(vault: FakeVault, renew?: { name: string; versionId: string }) {
  return renderPage(
    <CertificateImportDialog
      open
      project="payments"
      {...(renew === undefined ? {} : { renew })}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
    { vault, path: "/projects/payments/certificates" },
  );
}

function renderGenerate(vault: FakeVault) {
  return renderPage(
    <CertificateGenerateDialog open project="payments" onClose={vi.fn()} onSaved={vi.fn()} />,
    { vault, path: "/projects/payments/certificates" },
  );
}

function importRequest(vault: FakeVault) {
  return vault.requests.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/data/payments/certificates/import",
  );
}

function generateRequest(vault: FakeVault) {
  return vault.requests.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/data/payments/certificates/generate",
  );
}

async function fillMinimalImport(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Certificate name/), {
    target: { value: "imported-tls" },
  });
  fireEvent.change(screen.getByLabelText(/Leaf certificate PEM/), {
    target: { value: TEST_CERTIFICATE_PEM },
  });
  fireEvent.change(screen.getByLabelText(/Private key PEM/), {
    target: { value: TEST_PRIVATE_KEY_PEM },
  });
}

describe("certificate form internals", () => {
  it("should send an empty tag map when the tags field is blank", async () => {
    const vault = new FakeVault();
    renderImport(vault);
    await fillMinimalImport();
    fireEvent.click(screen.getByRole("button", { name: "Import certificate" }));

    await waitFor(() => expect(importRequest(vault)).toBeDefined());
    expect(importRequest(vault)?.body).toMatchObject({ tags: {} });
  });

  it("should reject duplicate tag keys without a request", async () => {
    const vault = new FakeVault();
    renderImport(vault);
    await fillMinimalImport();
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "env=a\nenv=b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import certificate" }));

    expect(await screen.findByText("Duplicate tag key: env")).toBeInTheDocument();
    expect(importRequest(vault)).toBeUndefined();
  });

  it("should reject a leaf file over 256 KiB and a key file over 64 KiB", async () => {
    const vault = new FakeVault();
    renderImport(vault);
    const leafInput = await screen.findByLabelText("Leaf certificate file");
    fireEvent.change(leafInput, {
      target: {
        files: [new File([`-----BEGIN CERTIFICATE-----\n${"a".repeat(262_200)}`], "big-leaf.pem")],
      },
    });
    expect(await screen.findByText(/larger than the allowed limit/)).toBeInTheDocument();

    const keyInput = screen.getByLabelText("Private key file");
    fireEvent.change(keyInput, {
      target: {
        files: [new File([`-----BEGIN PRIVATE KEY-----\n${"a".repeat(65_600)}`], "big.key")],
      },
    });
    expect(await screen.findByText(/larger than the allowed limit/)).toBeInTheDocument();
  });

  it("should accept 100 typed SANs", async () => {
    const vault = new FakeVault();
    renderGenerate(vault);
    const hundred = Array.from({ length: 100 }, (_, index) => `DNS:h${index}.example.test`);
    fireEvent.change(await screen.findByLabelText(/Certificate name/), {
      target: { value: "generated-tls" },
    });
    fireEvent.change(screen.getByLabelText(/Subject/), {
      target: { value: "CN=generated.example.test" },
    });
    fireEvent.change(screen.getByLabelText(/SANs/), { target: { value: hundred.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));
    await waitFor(() => expect(generateRequest(vault)).toBeDefined());
    expect(
      (generateRequest(vault)?.body as { sans?: readonly string[] } | undefined)?.sans,
    ).toHaveLength(100);
  });

  it("should reject 101 typed SANs", async () => {
    const vault = new FakeVault();
    renderGenerate(vault);
    const hundred = Array.from({ length: 100 }, (_, index) => `DNS:h${index}.example.test`);
    fireEvent.change(await screen.findByLabelText(/Certificate name/), {
      target: { value: "generated-tls" },
    });
    fireEvent.change(screen.getByLabelText(/Subject/), {
      target: { value: "CN=generated.example.test" },
    });
    fireEvent.change(screen.getByLabelText(/SANs/), {
      target: { value: [...hundred, "DNS:extra.example.test"].join("\n") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));
    expect(await screen.findByText(/at most 100 SANs/)).toBeInTheDocument();
    expect(generateRequest(vault)).toBeUndefined();
  });

  it("should keep the form values after a stale version conflict", async () => {
    const vault = new FakeVault();
    vault.failCertificate = {
      status: 409,
      code: "certificate_version_conflict",
      message: "This certificate changed. Reload the page and try again.",
    };
    renderImport(vault, { name: "api-tls", versionId: "01ARZ3NDEKTSV4RRFFQ69G5FC2" });
    await fillMinimalImport();
    const importButtons = screen.getAllByRole("button", { name: "Import new version" });
    const submit = importButtons[importButtons.length - 1];
    if (submit === undefined) {
      throw new Error("missing import submit button");
    }
    fireEvent.click(submit);

    expect(
      await screen.findByText("This certificate changed. Reload the page and try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Leaf certificate PEM/)).toHaveValue(TEST_CERTIFICATE_PEM);
    expect(importRequest(vault)?.body).toMatchObject({
      expectedVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
    });
  });
});
