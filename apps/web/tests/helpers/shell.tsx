import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AppShell } from "../../src/layout/app-shell.js";
import { SessionApiContext } from "../../src/session/session-api-provider.js";
import { SessionFixture } from "../../src/session/session-context.js";
import { ThemeRoot } from "../../src/theme/theme-root.js";
import { FakeVault } from "./fake-vault.js";
import { testClient, testSession } from "./render.js";

/** Shows the current router path for navigation assertions. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

/**
 * Renders the real application shell with a disposable session and router.
 *
 * The route table mirrors the two shell shapes: the project list at `/` and
 * any project route below `/projects/:project`.
 */
export function renderShell(
  options: { readonly initialPath?: string; readonly vault?: FakeVault } = {},
): ReturnType<typeof render> {
  const vault = options.vault ?? new FakeVault();
  const client = testClient(vault);
  const session = testSession();
  return render(
    <ThemeRoot>
      <SessionFixture value={session}>
        <SessionApiContext.Provider
          value={{ client, csrfToken: "c".repeat(32), refresh: async () => true }}
        >
          <MemoryRouter initialEntries={[options.initialPath ?? "/"]}>
            <Routes>
              <Route path="/" element={<AppShell />}>
                <Route index element={<p>Projects content</p>} />
              </Route>
              <Route path="/projects/:project/*" element={<AppShell />}>
                <Route
                  path="*"
                  element={
                    <>
                      <p>Project content</p>
                      <LocationProbe />
                    </>
                  }
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </SessionApiContext.Provider>
      </SessionFixture>
    </ThemeRoot>,
  );
}
