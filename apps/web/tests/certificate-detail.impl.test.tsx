import { readFileSync } from "node:fs";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Link, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { CERTIFICATE_VERSION_ID, FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function renderDetail(vault: FakeVault, name = "api-tls") {
  return renderProjectPage(<CertificateDetailPage />, {
    vault,
    path: `/projects/payments/certificates/${name}`,
    route: "/projects/:project/certificates/:name",
  });
}

describe("certificate detail internals", () => {
  it("should show a not-found state and a link back to the list", async () => {
    const vault = new FakeVault();
    renderDetail(vault, "missing-cert");

    expect(await screen.findByText("Certificate not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to certificates" })).toBeInTheDocument();
  });

  it("should reset the selected version when the loaded certificate changes", async () => {
    const vault = new FakeVault();
    const old = vault.certificates.find((entry) => entry.name === "old-tls");
    if (old === undefined) {
      throw new Error("missing fixture");
    }
    old.version = { ...old.version, id: "01ARZ3NDEKTSV4RRFFQ69G5FC9" };

    renderProjectPage(
      <>
        <Link to="/projects/payments/certificates/old-tls">Switch certificate</Link>
        <Routes>
          <Route path="/projects/:project/certificates/:name" element={<CertificateDetailPage />} />
        </Routes>
      </>,
      { vault, path: "/projects/payments/certificates/api-tls" },
    );

    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "01ARZ3NDEKTSV4RRFFQ69G5FZZ" },
    });
    expect(screen.getByLabelText("Version")).toHaveValue("01ARZ3NDEKTSV4RRFFQ69G5FZZ");

    fireEvent.click(screen.getByRole("link", { name: "Switch certificate" }));
    await screen.findByRole("heading", { name: "old-tls" });
    await waitFor(() => {
      expect(screen.getByLabelText("Version")).toHaveValue("");
    });
    expect(screen.getAllByText("01ARZ3NDEKTSV4RRFFQ69G5FC9").length).toBeGreaterThan(0);
  });

  it("should keep long metadata values in wrapping definition cells", async () => {
    const vault = new FakeVault();
    const certificate = vault.certificates[0];
    if (certificate === undefined) {
      throw new Error("missing fixture");
    }
    certificate.subject = `CN=${"a".repeat(500)}.example.test`;
    certificate.fingerprint = "b".repeat(64);
    renderDetail(vault);

    await screen.findByRole("heading", { name: "api-tls" });
    const fingerprint = screen.getByText("b".repeat(64));
    expect(fingerprint.closest("dd")).not.toBeNull();
    expect(screen.getByText(`CN=${"a".repeat(500)}.example.test`).closest("dd")).not.toBeNull();

    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain(".metadata-list dd");
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  it("should use the current version id for an expired certificate", async () => {
    const vault = new FakeVault();
    renderDetail(vault, "old-tls");
    await screen.findByRole("heading", { name: "old-tls" });
    expect(screen.getAllByText(CERTIFICATE_VERSION_ID).length).toBeGreaterThan(0);
    expect(screen.getByText(/Reading version/)).toHaveTextContent(CERTIFICATE_VERSION_ID);
  });
});
