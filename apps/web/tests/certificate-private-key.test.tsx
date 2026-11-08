import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Link } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { downloadPem } from "../src/components/pem.js";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { CERTIFICATE_VERSION_ID, FakeVault, TEST_PRIVATE_KEY_PEM } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

vi.mock("../src/components/pem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/pem.js")>();
  return { ...actual, downloadPem: vi.fn() };
});

function renderDetail(vault: FakeVault, name = "api-tls", status?: "active" | "deleted") {
  const suffix = status === "deleted" ? "?status=deleted" : "";
  return renderProjectPage(
    <>
      <CertificateDetailPage />
      <Link to="/projects/payments/certificates">Go to list</Link>
    </>,
    {
      vault,
      path: `/projects/payments/certificates/${name}${suffix}`,
      route: "/projects/:project/certificates/:name",
    },
  );
}

async function revealPrivate(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "View private key" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByLabelText("Private key");
}

function privateKeyRequests(vault: FakeVault): URLSearchParams[] {
  return vault.requests
    .filter(
      (entry) =>
        entry.method === "GET" &&
        entry.path === "/v1/data/payments/certificates/api-tls/private-key",
    )
    .map((entry) => new URLSearchParams(entry.query));
}

describe("certificate private key", () => {
  it("should hide the action without private-key capability and for a deleted certificate", async () => {
    const vault = new FakeVault();
    const certificate = vault.certificates[0];
    if (certificate === undefined) {
      throw new Error("missing fixture");
    }
    certificate.capabilities.canReadPrivate = false;
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    expect(screen.queryByRole("button", { name: "View private key" })).not.toBeInTheDocument();

    const deleted = new FakeVault();
    renderDetail(deleted, "retired-tls", "deleted");
    await screen.findByRole("heading", { name: "retired-tls" });
    expect(screen.queryByRole("button", { name: "View private key" })).not.toBeInTheDocument();
  });

  it("should confirm before reading and keep the key out until confirmation", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });

    fireEvent.click(screen.getByRole("button", { name: "View private key" }));
    expect(await screen.findByText(/Reveal the private key for api-tls/)).toBeInTheDocument();
    expect(vault.privateKeyRevealCount).toBe(0);
    expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
  });

  it("should read the selected version and show the key in a read-only field", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "01ARZ3NDEKTSV4RRFFQ69G5FZZ" },
    });
    await revealPrivate();

    const field = screen.getByLabelText("Private key") as HTMLTextAreaElement;
    expect(field.value).toBe(TEST_PRIVATE_KEY_PEM);
    expect(field.readOnly).toBe(true);
    expect(privateKeyRequests(vault).at(-1)?.get("version")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FZZ");
    expect(vault.privateKeyRevealCount).toBe(1);
  });

  it("should clear after sixty seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const vault = new FakeVault();
      renderDetail(vault);
      await screen.findByRole("heading", { name: "api-tls" });
      await revealPrivate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should clear when focus leaves the reveal region", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    fireEvent.blur(screen.getByLabelText("Private key"), { relatedTarget: document.body });
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });
  });

  it("should clear when the window loses focus", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    act(() => {
      fireEvent.blur(window);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });
  });

  it("should clear on a route change and on unmount", async () => {
    const vault = new FakeVault();
    const view = renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    fireEvent.click(screen.getByRole("link", { name: "Go to list" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    });

    const second = new FakeVault();
    const secondView = renderDetail(second);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();
    secondView.unmount();
    expect(screen.queryByLabelText("Private key")).not.toBeInTheDocument();
    view.unmount();
  });

  it("should download the key without storage, URL, console, cookie, or clipboard writes", async () => {
    const vault = new FakeVault();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    await revealPrivate();

    fireEvent.click(screen.getByRole("button", { name: "Download private key" }));
    expect(vi.mocked(downloadPem)).toHaveBeenCalledWith(
      `api-tls-${CERTIFICATE_VERSION_ID}.key.pem`,
      TEST_PRIVATE_KEY_PEM,
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TEST_PRIVATE_KEY_PEM);
    expect(document.cookie).not.toContain(TEST_PRIVATE_KEY_PEM);
    expect(clipboard).not.toHaveBeenCalledWith(TEST_PRIVATE_KEY_PEM);
    expect(consoleLog.mock.calls.flat().join(" ")).not.toContain(TEST_PRIVATE_KEY_PEM);
  });
});
