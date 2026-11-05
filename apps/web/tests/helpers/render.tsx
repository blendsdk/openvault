import { ConfirmProvider } from "@blendsdk/fluentui-react-components";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import { createOpenVaultWebClient } from "../../src/generated/index.js";
import {
  ProjectContextFixture,
  type ProjectContextValue,
} from "../../src/projects/project-route.js";
import { CsrfCookieAuth } from "../../src/session/csrf-cookie-auth.js";
import { type SessionApi, SessionApiContext } from "../../src/session/session-api-provider.js";
import { type AppSession, SessionFixture } from "../../src/session/session-context.js";
import { type FakeVault, TEST_CSRF } from "./fake-vault.js";

/** A signed-in test session. */
export function testSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    user: {
      sub: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      name: "Ada Admin",
      email: "ada@example.test",
      authMethod: "local",
    },
    isAuthenticated: true,
    isLoading: false,
    csrfToken: TEST_CSRF,
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => true),
    ...overrides,
  };
}

/** Creates the generated client backed by the fake adapter. */
export function testClient(vault: FakeVault) {
  return createOpenVaultWebClient({
    baseUrl: "",
    adapter: vault,
    auth: new CsrfCookieAuth({
      currentToken: () => TEST_CSRF,
      refresh: async () => true,
    }),
  });
}

/** The project fixture matching the fake vault. */
export function projectFixture(vault: FakeVault): ProjectContextValue {
  const project = vault.projects[0];
  if (project === undefined) {
    throw new Error("fake vault has no project");
  }
  return { project, projects: vault.projects, reload: vi.fn() };
}

function Harness({
  vault,
  session,
  path,
  route,
  children,
}: {
  readonly vault: FakeVault;
  readonly session: AppSession;
  readonly path: string;
  readonly route?: string;
  readonly children: ReactNode;
}) {
  const [client] = useState(() => testClient(vault));
  const api: SessionApi = {
    client,
    csrfToken: TEST_CSRF,
    refresh: async () => true,
  };
  return (
    <FluentProvider theme={webLightTheme}>
      <SessionFixture value={session}>
        <SessionApiContext.Provider value={api}>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              {route === undefined ? (
                children
              ) : (
                <Routes>
                  <Route path={route} element={children} />
                </Routes>
              )}
            </MemoryRouter>
          </ConfirmProvider>
        </SessionApiContext.Provider>
      </SessionFixture>
    </FluentProvider>
  );
}

/** Renders one page with the generated client, session, and router. */
export function renderPage(
  ui: ReactElement,
  options: {
    readonly vault: FakeVault;
    readonly session?: AppSession;
    readonly path?: string;
    readonly route?: string;
  },
): ReturnType<typeof render> {
  return render(
    <Harness
      vault={options.vault}
      session={options.session ?? testSession()}
      path={options.path ?? "/"}
      {...(options.route === undefined ? {} : { route: options.route })}
    >
      {ui}
    </Harness>,
  );
}

/** Renders a page inside a project context. */
export function renderProjectPage(
  ui: ReactElement,
  options: {
    readonly vault: FakeVault;
    readonly session?: AppSession;
    readonly path?: string;
    readonly route?: string;
  },
): ReturnType<typeof render> {
  return renderPage(
    <ProjectContextFixture value={projectFixture(options.vault)}>{ui}</ProjectContextFixture>,
    options,
  );
}
