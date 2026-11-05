import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuditPage } from "../src/pages/audit-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

describe("audit page", () => {
  it("should list events, filter by actor, and verify the chain", async () => {
    const vault = new FakeVault();
    renderProjectPage(<AuditPage />, { vault });

    expect(await screen.findByText("secret.read")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Actor id/), {
      target: { value: "01ARZ3NDEKTSV4RRFFQ69G5FB1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/audit/events" &&
            request.query.includes("actorId=01ARZ3NDEKTSV4RRFFQ69G5FB1"),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText("The chain is intact.")).toBeInTheDocument();
    expect(vault.requests.some((request) => request.path === "/v1/audit/verify")).toBe(true);
  });

  it("should show a broken chain reason and first event", async () => {
    const vault = new FakeVault();
    vault.auditBroken = true;
    renderProjectPage(<AuditPage />, { vault });
    await screen.findByText("secret.read");
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText(/hash_mismatch/)).toBeInTheDocument();
    expect(screen.getByText(/First broken event/)).toBeInTheDocument();
  });

  it("should open event details without rendering unsafe HTML", async () => {
    const vault = new FakeVault();
    renderProjectPage(<AuditPage />, { vault });
    await screen.findByText("secret.read");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText(/Event 01ARZ3NDEKTSV4RRFFQ69G5FB0/)).toBeInTheDocument();
    expect(screen.getAllByText(/req-1/).length).toBeGreaterThan(0);
  });
});
