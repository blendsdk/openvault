import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CertificatesPage } from "../src/pages/certificates-page.js";
import { endOfDayIso, startOfDayIso } from "../src/validation.js";
import { certificate, FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function renderList(vault: FakeVault) {
  return renderProjectPage(<CertificatesPage />, {
    vault,
    path: "/projects/payments/certificates",
    route: "/projects/:project/certificates",
  });
}

function lastListQuery(vault: FakeVault): URLSearchParams {
  const request = [...vault.requests]
    .reverse()
    .find((entry) => entry.method === "GET" && entry.path === "/v1/data/payments/certificates");
  return new URLSearchParams(request?.query ?? "");
}

describe("certificate list", () => {
  it("should render name, status, subject, expiry, and tags without private material", async () => {
    const vault = new FakeVault();
    renderList(vault);

    const link = await screen.findByRole("link", { name: "api-tls" });
    const row = link.closest("tr");
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).getByText("CN=api.payments.internal")).toBeInTheDocument();
    expect(within(row).getByText(/2027/)).toBeInTheDocument();
    expect(within(row).getByText("env=prod")).toBeInTheDocument();
    expect(screen.queryByText(/BEGIN CERTIFICATE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).not.toBeInTheDocument();
  });

  it("should send every filter and reset the cursor", async () => {
    const vault = new FakeVault();
    renderList(vault);
    await screen.findByRole("link", { name: "api-tls" });

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "api" } });
    fireEvent.change(screen.getByLabelText("SAN"), {
      target: { value: "DNS:api.payments.internal" },
    });
    fireEvent.change(screen.getByLabelText("Expires after"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Expires before"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => {
      expect(lastListQuery(vault).get("q")).toBe("api");
    });
    const query = lastListQuery(vault);
    expect(query.get("san")).toBe("DNS:api.payments.internal");
    expect(query.get("status")).toBe("active");
    expect(query.get("expiresAfter")).toBe(startOfDayIso("2026-01-01"));
    expect(query.get("expiresBefore")).toBe(endOfDayIso("2026-12-31"));
    expect(query.get("cursor")).toBeNull();
  });

  it("should append the next page and keep the applied filters", async () => {
    const vault = new FakeVault();
    vault.certificates = Array.from({ length: 30 }, (_, index) =>
      certificate({
        id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
        name: `bulk-${String(index).padStart(2, "0")}`,
        status: "active",
      }),
    );
    renderList(vault);

    expect(await screen.findByRole("link", { name: "bulk-00" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "bulk-24" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "bulk-25" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("link", { name: "bulk-29" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "bulk-00" })).toBeInTheDocument();
    const query = lastListQuery(vault);
    expect(query.get("cursor")).toBe("25");
    expect(query.get("status")).toBe("active");
    expect(query.get("limit")).toBe("25");
  });

  it("should show only deleted certificates and hide the create actions", async () => {
    const vault = new FakeVault();
    renderList(vault);
    await screen.findByRole("link", { name: "api-tls" });

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "deleted" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("link", { name: "retired-tls" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "api-tls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import certificate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument();
    expect(lastListQuery(vault).get("status")).toBe("deleted");
  });

  it("should show the active empty state with create actions", async () => {
    const empty = new FakeVault();
    empty.certificates = [];
    renderList(empty);
    const emptyState = await screen.findByRole("region", { name: "No certificates yet" });
    expect(
      within(emptyState).getByRole("button", { name: "Import certificate" }),
    ).toBeInTheDocument();
    expect(within(emptyState).getByRole("button", { name: "Generate" })).toBeInTheDocument();
  });

  it("should show the filtered empty state and clear the filters", async () => {
    const filtered = new FakeVault();
    renderList(filtered);
    await screen.findByRole("link", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "no-such-name" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("No certificates match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("link", { name: "api-tls" })).toBeInTheDocument();
  });

  it("should show the deleted empty state and return to active", async () => {
    const deletedEmpty = new FakeVault();
    deletedEmpty.certificates = deletedEmpty.certificates.filter(
      (entry) => entry.status !== "deleted",
    );
    renderList(deletedEmpty);
    await screen.findByRole("link", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "deleted" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText("No deleted certificates")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to active" }));
    expect(await screen.findByRole("link", { name: "api-tls" })).toBeInTheDocument();
  });

  it("should link a deleted row to the deleted detail view", async () => {
    const vault = new FakeVault();
    renderList(vault);
    await screen.findByRole("link", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "deleted" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    const link = await screen.findByRole("link", { name: "retired-tls" });
    expect(link).toHaveAttribute(
      "href",
      "/projects/payments/certificates/retired-tls?status=deleted",
    );
  });
});
