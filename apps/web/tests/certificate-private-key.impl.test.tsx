import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Link, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { FakeVault, TEST_PRIVATE_KEY_PEM } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function renderDetail(vault: FakeVault, name = "api-tls", status?: "active" | "deleted") {
  const suffix = status === "deleted" ? "?status=deleted" : "";
  return renderProjectPage(
    <>
      <Routes>
        <Route path="/projects/:project/certificates/:name" element={<CertificateDetailPage />} />
        <Route path="/projects/:project/certificates" element={<p>Certificate list</p>} />
      </Routes>
      <Link to="/projects/payments/certificates">Go to list</Link>
    </>,
    { vault, path: `/projects/payments/certificates/${name}${suffix}` },
  );
}

async function revealPrivate(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "View private key" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByLabelText("Private key");
}

describe("certificate lifecycle and private-key internals", () => {
  it.each([
    ["active", "api-tls", undefined, "Delete the certificate before purging it."],
    ["protected", "locked-tls", "deleted", "Purge protection is on and cannot be turned off."],
  ] as const)(
    "should explain why purge is unavailable (%s)",
    async (_label, name, status, reason) => {
      const vault = new FakeVault();
      renderDetail(vault, name, status);
      await screen.findByRole("heading", { name });
      expect(screen.getByRole("button", { name: "Purge" })).toBeDisabled();
      expect(screen.getByText(reason)).toBeInTheDocument();
    },
  );

  it("should explain the retention deadline", async () => {
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

  it("should clear the key on every documented trigger", async () => {
    const blurRegion = new FakeVault();
    const regionView = renderDetail(blurRegion);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    fireEvent.blur(screen.getByLabelText("Private key"), { relatedTarget: document.body });
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });
    regionView.unmount();

    const blurWindow = new FakeVault();
    const windowView = renderDetail(blurWindow);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    act(() => {
      fireEvent.blur(window);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });
    windowView.unmount();

    const routeChange = new FakeVault();
    const routeView = renderDetail(routeChange);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    fireEvent.click(screen.getByRole("link", { name: "Go to list" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });
    routeView.unmount();
  });

  it("should reset the countdown on a second reveal", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    expect(screen.getByText("Clears in 60s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide now" }));
    await revealPrivate();
    expect(screen.getByText("Clears in 60s")).toBeInTheDocument();
  });

  it("should keep a revealed key out of every browser store", async () => {
    const vault = new FakeVault();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TEST_PRIVATE_KEY_PEM);
    expect(document.cookie).not.toContain(TEST_PRIVATE_KEY_PEM);
    expect(clipboard).not.toHaveBeenCalledWith(TEST_PRIVATE_KEY_PEM);
    expect(consoleLog.mock.calls.flat().join(" ")).not.toContain(TEST_PRIVATE_KEY_PEM);
  });
});
