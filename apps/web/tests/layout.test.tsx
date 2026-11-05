import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { AppShell } from "../src/layout/app-shell.js";
import { SessionApiContext } from "../src/session/session-api-provider.js";
import { SessionFixture } from "../src/session/session-context.js";
import { ThemeRoot } from "../src/theme/theme-root.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { testClient, testSession } from "./helpers/render.js";

describe("application shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("should expose a skip link, navigation, theme toggle, and account menu", async () => {
    const session = testSession();
    const vault = new FakeVault();
    const client = testClient(vault);
    render(
      <ThemeRoot>
        <SessionFixture value={session}>
          <SessionApiContext.Provider
            value={{ client, csrfToken: "c".repeat(32), refresh: async () => true }}
          >
            <MemoryRouter initialEntries={["/"]}>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<p>Project content</p>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </SessionApiContext.Provider>
        </SessionFixture>
      </ThemeRoot>,
    );

    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Project content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeInTheDocument();
    expect(window.localStorage.getItem("openvault.theme")).toBe("dark");
    expect(JSON.stringify(window.localStorage)).not.toContain("s3cret");
  });
});
