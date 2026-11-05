import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SecretsPage } from "../src/pages/secrets-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

describe("secret list", () => {
  it("should show metadata without a value and apply search filters", async () => {
    const vault = new FakeVault();
    renderProjectPage(<SecretsPage />, { vault });

    expect(await screen.findByRole("link", { name: "db-password" })).toBeInTheDocument();
    expect(screen.queryByText("s3cret-value")).not.toBeInTheDocument();
    expect(vault.revealCount).toBe(0);

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "db" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/data/payments/secrets" && request.query.includes("q=db"),
        ),
      ).toBe(true);
    });
  });

  it("should render CLI guidance when no secret matches", async () => {
    const vault = new FakeVault();
    vault.emptySecrets = true;
    renderProjectPage(<SecretsPage />, { vault });
    expect(await screen.findByText("No secrets match")).toBeInTheDocument();
    expect(screen.getByText(/ov secret set/)).toBeInTheDocument();
  });

  it("should create a secret and clear the value from the dialog", async () => {
    const vault = new FakeVault();
    renderProjectPage(<SecretsPage />, { vault });
    await screen.findByRole("link", { name: "db-password" });
    fireEvent.click(screen.getByRole("button", { name: "New secret" }));

    fireEvent.change(await screen.findByLabelText(/Secret name/), {
      target: { value: "api-token" },
    });
    fireEvent.change(screen.getByLabelText(/Value/), { target: { value: "one-time-value" } });
    fireEvent.change(screen.getByLabelText(/Tags/), { target: { value: "env=prod\nteam=core" } });
    fireEvent.click(screen.getByRole("button", { name: "Create secret" }));

    await waitFor(() => {
      const request = vault.requests.find(
        (entry) => entry.method === "POST" && entry.path === "/v1/data/payments/secrets",
      );
      expect(request).toBeDefined();
      expect(request?.body).toMatchObject({
        name: "api-token",
        value: "one-time-value",
        tags: { env: "prod", team: "core" },
      });
    });
  });
});
