import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SecretDetailPage } from "../src/pages/secret-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

const PATH = "/projects/payments/secrets/db-password";
const ROUTE = "/projects/:project/secrets/:name";

describe("secret detail rotation card", () => {
  it("should show the policy, due state, last rotation, and consumer state", async () => {
    const vault = new FakeVault();
    renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
    expect(await screen.findByText("Rotation")).toBeInTheDocument();
    expect(screen.getByText("every 30 days")).toBeInTheDocument();
    expect(screen.getByText(/\(ok\)/)).toBeInTheDocument();
    expect(screen.getByText(/payments\/api/)).toBeInTheDocument();
  });

  it("should set and clear the policy", async () => {
    const vault = new FakeVault();
    renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
    await screen.findByText("Rotation");
    fireEvent.click(screen.getByRole("button", { name: "Set policy" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText("Interval days"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) => request.method === "PATCH" && request.path.endsWith("/secrets/db-password"),
        ),
      ).toBe(true);
    });
    const patch = vault.requests.filter((request) => request.method === "PATCH").at(-1);
    expect(patch?.body).toMatchObject({ rotationIntervalDays: 60 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Set policy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove policy" }));
    await waitFor(() => {
      const last = vault.requests.filter((request) => request.method === "PATCH").at(-1);
      expect(last?.body).toMatchObject({ rotationIntervalDays: null });
    });
    expect(dialog).toBeDefined();
  });

  it("should hide policy and rotate actions for a reader", async () => {
    const vault = new FakeVault();
    vault.secrets = vault.secrets.map((secret) => ({
      ...secret,
      capabilities: { ...secret.capabilities, canWrite: false },
    }));
    renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
    await screen.findByText("Rotation");
    expect(screen.queryByRole("button", { name: "Set policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();
  });
});
