import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectOverviewPage } from "../src/pages/project-overview-page.js";
import { ProjectsPage } from "../src/pages/projects-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderPage, renderProjectPage } from "./helpers/render.js";

describe("projects page", () => {
  it("should list projects and create one", async () => {
    const vault = new FakeVault();
    renderPage(<ProjectsPage />, { vault });

    expect(await screen.findByRole("link", { name: "payments" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "billing" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(await screen.findByLabelText(/Project name/), {
      target: { value: "reports" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/admin/projects" &&
            request.method === "POST" &&
            (request.body as { name?: string }).name === "reports",
        ),
      ).toBe(true);
    });
  });

  it("should reject an invalid project name before calling the API", async () => {
    const vault = new FakeVault();
    renderPage(<ProjectsPage />, { vault });
    await screen.findByRole("link", { name: "payments" });
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const field = await screen.findByLabelText(/Project name/);
    fireEvent.change(field, { target: { value: "Bad Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText(/Use 3–40 lowercase letters/)).toBeInTheDocument();
    });
    expect(vault.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("should rename a project and refresh the list", async () => {
    const vault = new FakeVault();
    renderPage(<ProjectsPage />, { vault });
    await screen.findByRole("link", { name: "payments" });
    const row = screen.getByRole("link", { name: "payments" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(/Project name/);
    fireEvent.change(field, { target: { value: "payments-v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.method === "PATCH" &&
            request.path === `/v1/admin/projects/${vault.projects[0]?.id ?? ""}`,
        ),
      ).toBe(true);
    });
    expect(await screen.findByRole("link", { name: "payments-v2" })).toBeInTheDocument();
  });

  it("should show due rotation counts on the project overview", async () => {
    const vault = new FakeVault();
    renderProjectPage(<ProjectOverviewPage />, { vault });
    expect(await screen.findByText("1 need attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open rotation" })).toBeInTheDocument();
  });

  it("should confirm before deleting a project", async () => {
    const vault = new FakeVault();
    renderPage(<ProjectsPage />, { vault });
    await screen.findByRole("link", { name: "payments" });
    const projectId = vault.projects[0]?.id ?? "";
    const row = screen.getByRole("link", { name: "payments" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Delete project payments/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.method === "DELETE" && request.path === `/v1/admin/projects/${projectId}`,
        ),
      ).toBe(true);
    });
  });
});
