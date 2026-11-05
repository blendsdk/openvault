import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logout: vi.fn(async () => undefined),
  auth: {
    user: {
      sub: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      name: "Ada Admin",
      email: "ada@example.test",
      authMethod: "local" as const,
    },
    isAuthenticated: true,
    isLoading: false,
    csrfToken: "c".repeat(32),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => true),
  },
}));
mocks.auth.logout = mocks.logout;

vi.mock("blendsdk/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("blendsdk/react")>();
  return { ...actual, useAuth: () => mocks.auth };
});

import { SessionApiProvider, useSessionApi } from "../src/session/session-api-provider.js";

function Probe() {
  const api = useSessionApi();
  return <span>{api.client === undefined ? "missing" : "ready"}</span>;
}

describe("session expiry", () => {
  beforeEach(() => {
    mocks.logout.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("should clear the auth state when refresh and /me both report an expired session", async () => {
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/me")) {
          meCalls += 1;
          if (meCalls === 1) {
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  csrfToken: "c".repeat(32),
                  expiresAt: new Date(Date.now() + 61_000).toISOString(),
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              success: false,
              error: { code: "authentication_required", message: "Authentication required" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/v1/auth/refresh")) {
          return new Response(
            JSON.stringify({ success: false, error: { code: "authentication_required" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );

    render(
      <SessionApiProvider>
        <Probe />
      </SessionApiProvider>,
    );

    await waitFor(() => {
      expect(meCalls).toBe(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => {
      expect(mocks.logout).toHaveBeenCalledTimes(1);
    });
  });
});
