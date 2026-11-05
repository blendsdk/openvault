import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretDetailPage } from "../src/pages/secret-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function renderDetail(vault: FakeVault) {
  return renderProjectPage(<SecretDetailPage />, {
    vault,
    path: "/projects/payments/secrets/db-password",
    route: "/projects/:project/secrets/:name",
  });
}

describe("secret detail", () => {
  it("should mask the value and read it only on reveal", async () => {
    const vault = new FakeVault();
    renderDetail(vault);

    expect(await screen.findByRole("heading", { name: "db-password" })).toBeInTheDocument();
    expect(screen.getByText("Value is masked")).toBeInTheDocument();
    expect(vault.revealCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const value = (await screen.findByLabelText("Revealed secret value")) as HTMLTextAreaElement;
    expect(value.value).toBe("s3cret-value");
    expect(vault.revealCount).toBe(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain("s3cret-value");
  });

  it("should clear the revealed value on blur", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    fireEvent.click(await screen.findByRole("button", { name: "Reveal" }));
    const value = await screen.findByLabelText("Revealed secret value");
    fireEvent.blur(value, { relatedTarget: document.body });
    await waitFor(() => {
      expect(screen.queryByLabelText("Revealed secret value")).not.toBeInTheDocument();
    });
  });

  it("should clear after sixty seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const vault = new FakeVault();
      renderDetail(vault);
      fireEvent.click(await screen.findByRole("button", { name: "Reveal" }));
      expect(await screen.findByLabelText("Revealed secret value")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.queryByLabelText("Revealed secret value")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should omit reveal without read capability and show a denied server read", async () => {
    const vault = new FakeVault();
    const secret = vault.secrets[0];
    if (secret === undefined) {
      throw new Error("missing fixture");
    }
    secret.capabilities.canRead = false;
    renderDetail(vault);
    await screen.findByRole("heading", { name: "db-password" });
    expect(screen.queryByRole("button", { name: "Reveal" })).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it("should show a server error if a reveal is denied", async () => {
    const vault = new FakeVault();
    vault.denyReveal = true;
    renderDetail(vault);
    fireEvent.click(await screen.findByRole("button", { name: "Reveal" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Access denied");
    expect(screen.queryByLabelText("Revealed secret value")).not.toBeInTheDocument();
  });
});
