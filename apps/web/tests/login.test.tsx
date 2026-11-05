import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/pages/login-page.js";
import { reloadTo } from "../src/session/reload.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderPage, testSession } from "./helpers/render.js";

vi.mock("../src/session/reload.js", () => ({ reloadTo: vi.fn() }));

const signedOut = testSession({
  user: null,
  isAuthenticated: false,
  csrfToken: null,
});

describe("login page", () => {
  beforeEach(() => {
    vi.mocked(reloadTo).mockClear();
  });

  it("should submit local credentials and reload into the project list", async () => {
    const vault = new FakeVault();
    renderPage(<LoginPage />, {
      vault,
      session: signedOut,
      path: "/login",
      route: "/login",
    });

    fireEvent.change(screen.getByLabelText(/Email or username/), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(vault.requests.some((request) => request.path === "/v1/auth/local/login")).toBe(true);
    });
    await waitFor(() => {
      expect(reloadTo).toHaveBeenCalledWith("/");
    });
    expect(screen.queryByText("Invalid credentials")).not.toBeInTheDocument();
  });

  it("should hide SSO when OIDC is disabled and show it when enabled", async () => {
    const vault = new FakeVault();
    const first = renderPage(<LoginPage />, {
      vault,
      session: signedOut,
      path: "/login",
      route: "/login",
    });
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("button", { name: "Continue with SSO" })).not.toBeInTheDocument();
    first.unmount();

    vault.oidcEnabled = true;
    const session = testSession({ user: null, isAuthenticated: false, csrfToken: null });
    renderPage(<LoginPage />, {
      vault,
      session,
      path: "/login",
      route: "/login",
    });
    const sso = await screen.findByRole("button", { name: "Continue with SSO" });
    fireEvent.click(sso);
    expect(session.login).toHaveBeenCalledWith("/");
  });

  it("should show one generic error for a rejected credential", async () => {
    const vault = new FakeVault();
    const original = vault.send.bind(vault);
    vault.send = async (request) => {
      if (request.url.endsWith("/v1/auth/local/login")) {
        return {
          status: 401,
          ok: false,
          body: {
            success: false,
            error: { code: "invalid_credentials", message: "Invalid credentials" },
          },
        };
      }
      return await original(request);
    };
    renderPage(<LoginPage />, {
      vault,
      session: signedOut,
      path: "/login",
      route: "/login",
    });
    fireEvent.change(screen.getByLabelText(/Email or username/), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid credentials");
    expect(alert).not.toHaveTextContent("ada@example.test");
    expect(reloadTo).not.toHaveBeenCalled();
  });
});
