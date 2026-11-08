import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CertificatesPage } from "../src/pages/certificates-page.js";
import { certificate, FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

function renderList(vault: FakeVault) {
  return renderProjectPage(<CertificatesPage />, {
    vault,
    path: "/projects/payments/certificates",
    route: "/projects/:project/certificates",
  });
}

function queries(vault: FakeVault): URLSearchParams[] {
  return vault.requests
    .filter((entry) => entry.method === "GET" && entry.path === "/v1/data/payments/certificates")
    .map((entry) => new URLSearchParams(entry.query));
}

describe("certificate list internals", () => {
  it("should drop appended rows and the cursor when a filter changes", async () => {
    const vault = new FakeVault();
    vault.certificates = Array.from({ length: 30 }, (_, index) =>
      certificate({
        id: `01ARZ3NDEKTSV4RRFFQ69G5G${String(index).padStart(2, "0")}`,
        name: `paged-${String(index).padStart(2, "0")}`,
        status: "active",
      }),
    );
    renderList(vault);
    await screen.findByRole("link", { name: "paged-00" });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "paged-29" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "paged-0" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => {
      const last = queries(vault).at(-1);
      expect(last?.get("q")).toBe("paged-0");
    });
    const last = queries(vault).at(-1);
    expect(last?.get("cursor")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "paged-29" })).not.toBeInTheDocument();
    });
  });

  it.each([768, 390])("should keep the name and status columns at %i px", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const vault = new FakeVault();
    renderList(vault);
    await screen.findByRole("link", { name: "api-tls" });

    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Certificates" })).toHaveAttribute("tabindex", "0");
  });

  it("should send the local start and end of the selected days", async () => {
    const vault = new FakeVault();
    renderList(vault);
    await screen.findByRole("link", { name: "api-tls" });
    fireEvent.change(screen.getByLabelText("Expires after"), {
      target: { value: "2026-03-29" },
    });
    fireEvent.change(screen.getByLabelText("Expires before"), {
      target: { value: "2026-03-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => {
      expect(queries(vault).at(-1)?.get("expiresAfter")).not.toBeNull();
    });
    const after = new Date(queries(vault).at(-1)?.get("expiresAfter") ?? "");
    const before = new Date(queries(vault).at(-1)?.get("expiresBefore") ?? "");
    expect(after.getHours()).toBe(0);
    expect(after.getMinutes()).toBe(0);
    expect(before.getHours()).toBe(23);
    expect(before.getMinutes()).toBe(59);
  });
});
