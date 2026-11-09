import { fireEvent, screen } from "@testing-library/react";
import { ApiError } from "blendsdk/api-client";
import { describe, expect, it } from "vitest";
import { rotationErrorText } from "../src/components/rotation-errors.js";
import { SecretDetailPage } from "../src/pages/secret-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderProjectPage } from "./helpers/render.js";

const PATH = "/projects/payments/secrets/db-password";
const ROUTE = "/projects/:project/secrets/:name";

function apiError(statusCode: number, code: string, message: string): ApiError {
  return new ApiError(message, { statusCode, code, operationId: "test" });
}

async function openPolicy(vault: FakeVault): Promise<void> {
  renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
  await screen.findByText("Rotation");
  fireEvent.click(screen.getByRole("button", { name: "Set policy" }));
  await screen.findByRole("button", { name: "Save policy" });
}

describe("rotation error mapping", () => {
  it("should map the documented rotation error codes", () => {
    expect(rotationErrorText(apiError(403, "access_denied", "denied"))).toBe(
      "You do not have permission for this action.",
    );
    expect(rotationErrorText(apiError(404, "secret_not_found", "missing"))).toBe(
      "Secret not found.",
    );
    expect(rotationErrorText(apiError(422, "validation_error", "invalid"))).toBe(
      "The form values are not valid.",
    );
    expect(rotationErrorText(apiError(409, "secret_version_limit", "limit"))).toBe(
      "This secret has reached its version limit.",
    );
    expect(rotationErrorText(apiError(409, "idempotency_conflict", "conflict"))).toBe(
      "The request conflicted with an earlier request. Try again.",
    );
    expect(rotationErrorText(apiError(500, "internal_error", "broken"))).toBeUndefined();
  });

  it("should render the access-denied message for a policy update", async () => {
    const vault = new FakeVault();
    await openPolicy(vault);
    vault.secretMetadataFault = { status: 403, code: "access_denied", message: "denied" };
    fireEvent.change(screen.getByLabelText("Interval days"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You do not have permission for this action.");
  });

  it("should render the validation message and keep the policy dialog open", async () => {
    const vault = new FakeVault();
    await openPolicy(vault);
    vault.secretMetadataFault = { status: 422, code: "validation_error", message: "invalid" };
    fireEvent.change(screen.getByLabelText("Interval days"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The form values are not valid.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should render a safe fallback for an unknown write failure", async () => {
    const vault = new FakeVault();
    renderProjectPage(<SecretDetailPage />, { vault, path: PATH, route: ROUTE });
    await screen.findByText("Rotation");
    fireEvent.click(screen.getByRole("button", { name: "Rotate now" }));
    await screen.findByRole("button", { name: "Rotate secret" });
    vault.secretWriteFault = {
      status: 500,
      code: "internal_error",
      message: "Internal Server Error",
    };
    fireEvent.change(screen.getByLabelText("New value"), { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Internal Server Error");
    expect(alert).not.toHaveTextContent("stack");
  });
});
