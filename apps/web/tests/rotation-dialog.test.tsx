import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretDetailPage } from "../src/pages/secret-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

const PATH = "/projects/payments/secrets/db-password";
const ROUTE = "/projects/:project/secrets/:name";

async function openDialog(vault: FakeVault): Promise<void> {
  renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
  await screen.findByText("Rotation");
  fireEvent.click(screen.getByRole("button", { name: "Rotate now" }));
  await screen.findByRole("dialog");
}

describe("rotate dialog", () => {
  it("should rotate with a manual value and expiry", async () => {
    const vault = new FakeVault();
    await openDialog(vault);
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "manual-rotation" } });
    fireEvent.change(screen.getByLabelText("Expires at (optional ISO)"), {
      target: { value: "2027-01-01T00:00:00.000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => {
      const put = vault.requests.filter((request) => request.method === "PUT").at(-1);
      expect(put?.body).toMatchObject({
        value: "manual-rotation",
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("should generate and regenerate a 43-character value", async () => {
    const vault = new FakeVault();
    await openDialog(vault);
    fireEvent.click(screen.getByRole("button", { name: "Generate value" }));
    const input = screen.getByLabelText("New value") as HTMLInputElement;
    const first = input.value;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(input.value).not.toBe(first);
    expect(input.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("should clear the value and not persist it on close", async () => {
    const vault = new FakeVault();
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    await openDialog(vault);
    fireEvent.click(screen.getByRole("button", { name: "Generate value" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it("should keep the value and dialog open after a failed write", async () => {
    const vault = new FakeVault();
    await openDialog(vault);
    vault.failNextSecretWrite = true;
    fireEvent.click(screen.getByRole("button", { name: "Generate value" }));
    const failedValue = (screen.getByLabelText("New value") as HTMLInputElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe(failedValue);
  });
});
