import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionsPage } from "../src/pages/permissions-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

describe("permissions page", () => {
  it("should explain project access and list assignments", async () => {
    const vault = new FakeVault();
    renderProjectPage(<PermissionsPage />, { vault });

    expect(await screen.findByText("Project-scope assignments")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));

    await waitFor(() => {
      expect(screen.getByText("payments-api")).toBeInTheDocument();
    });
    expect(screen.getAllByText("secrets.reader").length).toBeGreaterThan(0);
    expect(screen.getByText(/object: db-password/)).toBeInTheDocument();
    expect(vault.requests.some((request) => request.path === "/v1/admin/access-explain")).toBe(
      true,
    );
  });

  it("should block an invalid object-scope grant before calling the API", async () => {
    const vault = new FakeVault();
    renderProjectPage(<PermissionsPage />, { vault });
    await screen.findByText("Project-scope assignments");
    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));

    await waitFor(() => {
      expect(screen.getByText("Choose or enter a principal id.")).toBeInTheDocument();
    });
    expect(vault.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("should revoke an assignment after confirmation", async () => {
    const vault = new FakeVault();
    renderProjectPage(<PermissionsPage />, { vault });
    await screen.findByText("Project-scope assignments");
    const revoke = screen.getAllByRole("button", { name: "Revoke" })[0];
    expect(revoke).toBeDefined();
    fireEvent.click(revoke as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path === `/v1/admin/assignments/${vault.assignments[0]?.id ?? ""}`,
        ),
      ).toBe(true);
    });
  });
});
