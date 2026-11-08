import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { downloadPem } from "../src/components/pem.js";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import {
  CERTIFICATE_VERSION_ID,
  FakeVault,
  TEST_CERTIFICATE_PEM,
  TEST_CHAIN_PEM,
} from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

vi.mock("../src/components/pem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/pem.js")>();
  return { ...actual, downloadPem: vi.fn() };
});

function renderDetail(
  vault: FakeVault,
  options: { readonly name?: string; readonly status?: "active" | "deleted" } = {},
) {
  const name = options.name ?? "api-tls";
  const suffix = options.status === "deleted" ? "?status=deleted" : "";
  return renderProjectPage(<CertificateDetailPage />, {
    vault,
    path: `/projects/payments/certificates/${name}${suffix}`,
    route: "/projects/:project/certificates/:name",
  });
}

function readRequests(vault: FakeVault): URLSearchParams[] {
  return vault.requests
    .filter(
      (entry) => entry.method === "GET" && entry.path === "/v1/data/payments/certificates/api-tls",
    )
    .map((entry) => new URLSearchParams(entry.query));
}

describe("certificate detail", () => {
  it("should show the metadata fields without private material", async () => {
    const vault = new FakeVault();
    renderDetail(vault);

    expect(await screen.findByRole("heading", { name: "api-tls" })).toBeInTheDocument();
    expect(screen.getByText("CN=api.payments.internal")).toBeInTheDocument();
    expect(screen.getByText("DNS:api.payments.internal")).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getAllByText(CERTIFICATE_VERSION_ID).length).toBeGreaterThan(0);
    expect(screen.getByText("env=prod")).toBeInTheDocument();
    expect(screen.getByText("Purge protected")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText(/BEGIN PRIVATE KEY/)).not.toBeInTheDocument();
  });

  it("should read the selected version and render the leaf and chain", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });

    fireEvent.change(screen.getByLabelText("Version"), {
      target: { value: "01ARZ3NDEKTSV4RRFFQ69G5FZZ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "View public certificate" }));

    const leaf = (await screen.findByLabelText("Leaf certificate")) as HTMLTextAreaElement;
    const chain = (await screen.findByLabelText("Intermediate chain")) as HTMLTextAreaElement;
    expect(leaf.value).toBe(TEST_CERTIFICATE_PEM);
    expect(chain.value).toBe(TEST_CHAIN_PEM);
    const query = readRequests(vault).at(-1);
    expect(query?.get("version")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FZZ");
  });

  it("should copy and download the public leaf and chain", async () => {
    const vault = new FakeVault();
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.click(screen.getByRole("button", { name: "View public certificate" }));
    await screen.findByLabelText("Leaf certificate");

    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    fireEvent.click(screen.getByRole("button", { name: "Copy leaf" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEST_CERTIFICATE_PEM));
    fireEvent.click(screen.getByRole("button", { name: "Copy chain" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEST_CHAIN_PEM));

    fireEvent.click(screen.getByRole("button", { name: "Download leaf" }));
    expect(vi.mocked(downloadPem)).toHaveBeenCalledWith(
      "api-tls-certificate.pem",
      TEST_CERTIFICATE_PEM,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download chain" }));
    expect(vi.mocked(downloadPem)).toHaveBeenCalledWith("api-tls-chain.pem", TEST_CHAIN_PEM);
  });

  it("should show no intermediate chain when the chain is empty", async () => {
    const vault = new FakeVault();
    vault.certificateChainPem = "";
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    fireEvent.click(screen.getByRole("button", { name: "View public certificate" }));
    expect(await screen.findByText("No intermediate chain")).toBeInTheDocument();
  });

  it("should read an expired current certificate with its current version id", async () => {
    const vault = new FakeVault();
    renderDetail(vault, { name: "old-tls" });
    await screen.findByRole("heading", { name: "old-tls" });
    fireEvent.click(screen.getByRole("button", { name: "View public certificate" }));

    const leaf = await screen.findByLabelText("Leaf certificate");
    expect(leaf).toBeInTheDocument();
    const request = vault.requests
      .filter(
        (entry) =>
          entry.method === "GET" && entry.path === "/v1/data/payments/certificates/old-tls",
      )
      .map((entry) => new URLSearchParams(entry.query))
      .at(-1);
    expect(request?.get("version")).toBe(CERTIFICATE_VERSION_ID);
  });

  it("should hide public material without certificate read access", async () => {
    const vault = new FakeVault();
    const certificate = vault.certificates[0];
    if (certificate === undefined) {
      throw new Error("missing fixture");
    }
    certificate.capabilities.canRead = false;
    renderDetail(vault);
    await screen.findByRole("heading", { name: "api-tls" });
    expect(
      screen.queryByRole("button", { name: "View public certificate" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("CN=api.payments.internal")).toBeInTheDocument();
  });

  it("should load a deleted certificate from the deleted view and hide public material", async () => {
    const vault = new FakeVault();
    renderDetail(vault, { name: "retired-tls", status: "deleted" });

    expect(await screen.findByRole("heading", { name: "retired-tls" })).toBeInTheDocument();
    expect(screen.getAllByText("deleted").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "View public certificate" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Public material is unavailable/)).toBeInTheDocument();
    const listRequest = vault.requests.find(
      (entry) =>
        entry.method === "GET" &&
        entry.path === "/v1/data/payments/certificates" &&
        new URLSearchParams(entry.query).get("q") === "retired-tls",
    );
    expect(new URLSearchParams(listRequest?.query ?? "").get("status")).toBe("deleted");
  });
});
