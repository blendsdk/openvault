import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RotationPage } from "../src/pages/rotation-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

describe("rotation page", () => {
  it("should list policy secrets with status, due date, interval, and last rotation", async () => {
    const vault = new FakeVault();
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation",
      route: "/projects/:project/rotation",
    });

    expect(await screen.findByRole("link", { name: "db-password" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "api-key" })).toBeInTheDocument();
    expect(screen.getAllByText("every 30 days").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/data/payments/secrets" &&
            request.query.includes("rotation=policy"),
        ),
      ).toBe(true);
    });
  });

  it("should initialize the due filter from the URL", async () => {
    const vault = new FakeVault();
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation?status=due",
      route: "/projects/:project/rotation",
    });

    expect(await screen.findByRole("link", { name: "api-key" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "db-password" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/data/payments/secrets" && request.query.includes("rotation=due"),
        ),
      ).toBe(true);
    });
  });

  it("should apply the overdue filter", async () => {
    const vault = new FakeVault();
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation",
      route: "/projects/:project/rotation",
    });
    await screen.findByRole("link", { name: "api-key" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "overdue" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/data/payments/secrets" &&
            request.query.includes("rotation=overdue"),
        ),
      ).toBe(true);
    });
  });

  it("should reset the filters to the all-policies view", async () => {
    const vault = new FakeVault();
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation?status=due",
      route: "/projects/:project/rotation",
    });
    await screen.findByRole("link", { name: "api-key" });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(
        vault.requests.some(
          (request) =>
            request.path === "/v1/data/payments/secrets" &&
            request.query.includes("rotation=policy"),
        ),
      ).toBe(true);
    });
  });

  it("should show the no-policies empty state with a link to secrets", async () => {
    const vault = new FakeVault();
    vault.emptySecrets = true;
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation",
      route: "/projects/:project/rotation",
    });
    expect(await screen.findByText("No rotation policies yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set a policy from a secret" })).toBeInTheDocument();
  });

  it("should hide write actions for a reader", async () => {
    const vault = new FakeVault();
    vault.secrets = vault.secrets.map((secret) => ({
      ...secret,
      capabilities: { ...secret.capabilities, canWrite: false },
    }));
    renderProjectPage(<RotationPage />, {
      vault,
      path: "/projects/payments/rotation",
      route: "/projects/:project/rotation",
    });
    await screen.findByRole("link", { name: "api-key" });
    expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
  });
});
