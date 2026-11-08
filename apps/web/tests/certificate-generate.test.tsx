import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CertificateGenerateDialog } from "../src/components/certificate-generate-dialog.js";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import {
  CERTIFICATE_VERSION_ID,
  FakeVault,
  TEST_CERTIFICATE_PEM,
  TEST_PRIVATE_KEY_PEM,
} from "./helpers/fake-vault.js";
import { renderPage, renderProjectPage } from "./helpers/render.js";

function renderGenerate(vault: FakeVault) {
  return renderPage(
    <CertificateGenerateDialog open project="payments" onClose={vi.fn()} onSaved={vi.fn()} />,
    { vault, path: "/projects/payments/certificates" },
  );
}

function generateRequest(vault: FakeVault) {
  return vault.requests.find(
    (entry) => entry.method === "POST" && entry.path === "/v1/data/payments/certificates/generate",
  );
}

async function fillGenerateForm(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Certificate name/), {
    target: { value: "generated-tls" },
  });
  fireEvent.change(screen.getByLabelText(/Subject/), {
    target: { value: "CN=generated.example.test" },
  });
  fireEvent.change(screen.getByLabelText(/SANs/), {
    target: { value: "DNS:generated.example.test\nIP:10.0.0.5" },
  });
  fireEvent.change(screen.getByLabelText("Key type"), { target: { value: "rsa-2048" } });
  fireEvent.change(screen.getByLabelText("Validity days"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "env=test" } });
}

describe("certificate generate and renew", () => {
  it("should send the subject, typed SANs, key type, validity, and tags", async () => {
    const vault = new FakeVault();
    renderGenerate(vault);
    await fillGenerateForm();
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));

    await waitFor(() => expect(generateRequest(vault)).toBeDefined());
    expect(generateRequest(vault)?.body).toMatchObject({
      name: "generated-tls",
      subject: "CN=generated.example.test",
      sans: ["DNS:generated.example.test", "IP:10.0.0.5"],
      keyType: "rsa-2048",
      validityDays: 30,
      tags: { env: "test" },
    });
  });

  it("should block a SAN without a prefix, an empty SAN list, and invalid validity", async () => {
    const vault = new FakeVault();
    renderGenerate(vault);
    fireEvent.change(await screen.findByLabelText(/Certificate name/), {
      target: { value: "generated-tls" },
    });
    fireEvent.change(screen.getByLabelText(/Subject/), {
      target: { value: "CN=generated.example.test" },
    });
    fireEvent.change(screen.getByLabelText(/SANs/), {
      target: { value: "generated.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));
    expect(await screen.findByText(/must start with DNS:/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/SANs/), { target: { value: "DNS:ok.test" } });
    fireEvent.change(screen.getByLabelText("Validity days"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));
    expect(await screen.findByText(/between 1 and 825/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Validity days"), { target: { value: "826" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate certificate" }));
    expect(await screen.findByText(/between 1 and 825/)).toBeInTheDocument();
    expect(generateRequest(vault)).toBeUndefined();
  });

  it("should renew with the current version id even when a past version is selected", async () => {
    const vault = new FakeVault();
    renderProjectPage(<CertificateDetailPage />, {
      vault,
      path: "/projects/payments/certificates/api-tls",
      route: "/projects/:project/certificates/:name",
    });
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "01ARZ3NDEKTSV4RRFFQ69G5FZZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate new version" }));
    await screen.findByLabelText(/Certificate name/);
    expect(screen.getByLabelText(/Certificate name/)).toHaveValue("api-tls");
    fireEvent.change(screen.getByLabelText(/Subject/), {
      target: { value: "CN=api.payments.internal" },
    });
    fireEvent.change(screen.getByLabelText(/SANs/), {
      target: { value: "DNS:api.payments.internal" },
    });
    const generateButtons = screen.getAllByRole("button", { name: "Generate new version" });
    const generateButton = generateButtons[generateButtons.length - 1];
    if (generateButton === undefined) {
      throw new Error("missing generate submit button");
    }
    fireEvent.click(generateButton);

    await waitFor(() => expect(generateRequest(vault)).toBeDefined());
    expect(generateRequest(vault)?.body).toMatchObject({
      expectedVersionId: CERTIFICATE_VERSION_ID,
    });
    expect(generateRequest(vault)?.body).not.toMatchObject({
      expectedVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FZZ",
    });
  });

  it("should keep the import dialog open on a stale version conflict", async () => {
    const vault = new FakeVault();
    renderProjectPage(<CertificateDetailPage />, {
      vault,
      path: "/projects/payments/certificates/api-tls",
      route: "/projects/:project/certificates/:name",
    });
    await screen.findByRole("heading", { name: "api-tls" });
    vault.failCertificate = {
      status: 409,
      code: "certificate_version_conflict",
      message: "This certificate changed. Reload the page and try again.",
    };
    fireEvent.click(screen.getByRole("button", { name: "Import new version" }));
    fireEvent.change(await screen.findByLabelText(/Leaf certificate PEM/), {
      target: { value: TEST_CERTIFICATE_PEM },
    });
    fireEvent.change(screen.getByLabelText(/Private key PEM/), {
      target: { value: TEST_PRIVATE_KEY_PEM },
    });
    const importButtons = screen.getAllByRole("button", { name: "Import new version" });
    const importButton = importButtons[importButtons.length - 1];
    if (importButton === undefined) {
      throw new Error("missing import submit button");
    }
    fireEvent.click(importButton);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This certificate changed. Reload the page and try again.");
    expect(screen.getByLabelText(/Certificate name/)).toBeInTheDocument();
  });
});
