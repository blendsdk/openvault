import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DOCS_BASE_URL } from "../src/docs.js";
import { renderShell } from "./helpers/shell.js";

describe("application shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("should expose a skip link, launcher, brand, theme toggle, and account menu", async () => {
    renderShell();

    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("link", { name: "OpenVault home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      `${DOCS_BASE_URL}/guide/secrets#projects`,
    );
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    expect(screen.getByText("Projects content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(await screen.findByRole("searchbox", { name: "Search navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeInTheDocument();
    expect(window.localStorage.getItem("openvault.theme")).toBe("dark");
    expect(JSON.stringify(window.localStorage)).not.toContain("s3cret");
  });

  it("should list project sections, filter them, and navigate from the launcher", async () => {
    renderShell({ initialPath: "/projects/payments/secrets" });

    expect(screen.getByText("Project content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      `${DOCS_BASE_URL}/guide/secrets#secret-write-and-read`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const search = await screen.findByRole("searchbox", { name: "Search navigation" });
    for (const label of [
      "Overview",
      "Secrets",
      "Identities",
      "Permissions",
      "Audit",
      "Consumers",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "audit" } });
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/projects/payments/audit");
    });
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      `${DOCS_BASE_URL}/guide/audit`,
    );
  });

  it("should show an empty state when no destination matches", async () => {
    renderShell({ initialPath: "/projects/payments/secrets" });
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const search = await screen.findByRole("searchbox", { name: "Search navigation" });
    fireEvent.change(search, { target: { value: "no-such-destination" } });
    expect(screen.getByText(/No destinations match/)).toBeInTheDocument();
  });
});
