import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderDetail(vault: FakeVault, name = "api-tls", status?: "active" | "deleted") {
  const suffix = status === "deleted" ? "?status=deleted" : "";
  return renderProjectPage(
    <>
      <Routes>
        <Route path="/projects/:project/certificates/:name" element={<CertificateDetailPage />} />
        <Route path="/projects/:project/certificates" element={<p>Certificate list</p>} />
      </Routes>
      <LocationProbe />
    </>,
    {
      vault,
      path: `/projects/payments/certificates/${name}${suffix}`,
    },
  );
}

async function deleteCertificate(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
}

describe("certificate metadata and lifecycle", () => {
  it("should patch tags and turn purge protection on", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.change(await screen.findByLabelText("Tags"), {
      target: { value: "env=stage" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Purge protection" }));
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() => {
      const request = vault.requests.find(
        (entry) =>
          entry.method === "PATCH" && entry.path === "/v1/data/payments/certificates/api-tls",
      );
      expect(request?.body).toMatchObject({
        tags: { env: "stage" },
        purgeProtected: true,
      });
    });
  });

  it("should disable the protection switch when protection is already on", async () => {
    const vault = new FakeVault();
    const certificate = vault.certificates[0];
    if (certificate === undefined) {
      throw new Error("missing fixture");
    }
    certificate.purgeProtected = true;
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));

    const protection = await screen.findByRole("switch", { name: "Purge protection" });
    expect(protection).toBeChecked();
    expect(protection).toBeDisabled();
    expect(screen.getByText("Purge protection cannot be turned off.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "env=stage" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() => {
      const request = vault.requests.find(
        (entry) =>
          entry.method === "PATCH" && entry.path === "/v1/data/payments/certificates/api-tls",
      );
      expect(request?.body).toMatchObject({ tags: { env: "stage" } });
      expect(request?.body).not.toHaveProperty("purgeProtected");
    });
  });

  it("should delete after confirmation and show the deleted state", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await deleteCertificate();

    expect(await screen.findByRole("button", { name: "Recover" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Purge" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("?status=deleted");
    });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("should recover a deleted certificate without a confirmation", async () => {
    const vault = new FakeVault();
    renderDetail(vault, "retired-tls", "deleted");
    await screen.findByRole("heading", { name: "retired-tls" });
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));

    await waitFor(() => {
      expect(
        vault.requests.some(
          (entry) =>
            entry.method === "POST" &&
            entry.path === "/v1/data/payments/certificates/retired-tls/recover",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("?status=active");
    });
    expect(await screen.findByRole("button", { name: "Import new version" })).toBeInTheDocument();
  });

  it("should disable purge with a reason while active", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });

    const purge = screen.getByRole("button", { name: "Purge" });
    expect(purge).toBeDisabled();
    expect(screen.getByText("Delete the certificate before purging it.")).toBeInTheDocument();
    expect(
      vault.requests.some((entry) => entry.path === "/v1/data/payments/certificates/api-tls/purge"),
    ).toBe(false);
  });

  it("should disable purge while protection is on", async () => {
    const vault = new FakeVault();
    renderDetail(vault, "locked-tls", "deleted");
    await screen.findByRole("heading", { name: "locked-tls" });

    expect(screen.getByRole("button", { name: "Purge" })).toBeDisabled();
    expect(
      screen.getByText("Purge protection is on and cannot be turned off."),
    ).toBeInTheDocument();
  });

  it("should disable purge before the retention deadline", async () => {
    const vault = new FakeVault();
    const retired = vault.certificates.find((entry) => entry.name === "retired-tls");
    if (retired === undefined) {
      throw new Error("missing fixture");
    }
    retired.purgeAfter = "2099-01-01T00:00:00.000Z";
    renderDetail(vault, "retired-tls", "deleted");
    await screen.findByRole("heading", { name: "retired-tls" });

    expect(screen.getByRole("button", { name: "Purge" })).toBeDisabled();
    expect(screen.getByText(/Purge is available after/)).toBeInTheDocument();
  });

  it("should purge after confirmation and return to the list", async () => {
    const vault = new FakeVault();
    renderDetail(vault, "retired-tls", "deleted");
    await screen.findByRole("heading", { name: "retired-tls" });
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(
        vault.requests.some(
          (entry) =>
            entry.method === "POST" &&
            entry.path === "/v1/data/payments/certificates/retired-tls/purge",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/payments/certificates");
    });
  });
});
