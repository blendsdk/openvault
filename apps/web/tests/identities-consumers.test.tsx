import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConsumersPage } from "../src/pages/consumers-page.js";
import { IdentitiesPage } from "../src/pages/identities-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

describe("identities and consumers", () => {
  it("should list identities and show a join token exactly once", async () => {
    const vault = new FakeVault();
    renderProjectPage(<IdentitiesPage />, { vault });

    expect(await screen.findByText("payments-api")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join token" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/shown once/)).toBeInTheDocument();
    expect(within(dialog).getByText("T".repeat(43))).toBeInTheDocument();
    expect(vault.requests.some((request) => request.path.endsWith("/join-tokens"))).toBe(true);
  });

  it("should revoke an identity after confirmation", async () => {
    const vault = new FakeVault();
    renderProjectPage(<IdentitiesPage />, { vault });
    await screen.findByText("payments-api");
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.method === "POST" &&
            request.path === `/v1/admin/identities/${vault.identities[0]?.id ?? ""}/revoke`,
        ),
      ).toBe(true);
    });
  });

  it("should list consumers without host paths", async () => {
    const vault = new FakeVault();
    renderProjectPage(<ConsumersPage />, { vault });
    expect(await screen.findByText("payments")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("internal-host")).not.toBeInTheDocument();
  });
});
