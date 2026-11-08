import { screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { AuditPage } from "../src/pages/audit-page.js";
import { CertificateDetailPage } from "../src/pages/certificate-detail-page.js";
import { CertificatesPage } from "../src/pages/certificates-page.js";
import { LoginPage } from "../src/pages/login-page.js";
import { SecretDetailPage } from "../src/pages/secret-detail-page.js";
import { FakeVault } from "./helpers/fake-vault.js";
import { renderPage, renderProjectPage, testSession } from "./helpers/render.js";
import { renderShell } from "./helpers/shell.js";

async function expectNoSeriousAxe(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: {
      // jsdom has no layout engine, so contrast cannot be measured.
      "color-contrast": { enabled: false },
    },
  });
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    serious,
    serious.map((violation) => `${violation.id}: ${violation.help}`).join("\n"),
  ).toEqual([]);
}

describe("accessibility", () => {
  it("should pass axe on login", async () => {
    const vault = new FakeVault();
    const result = renderPage(<LoginPage />, {
      vault,
      session: testSession({ user: null, isAuthenticated: false, csrfToken: null }),
      path: "/login",
      route: "/login",
    });
    await screen.findByRole("heading", { name: "Sign in" });
    await expectNoSeriousAxe(result.container);
  });

  it("should pass axe on secret detail", async () => {
    const vault = new FakeVault();
    const result = renderProjectPage(<SecretDetailPage />, {
      vault,
      path: "/projects/payments/secrets/db-password",
      route: "/projects/:project/secrets/:name",
    });
    await screen.findByRole("heading", { name: "db-password" });
    await expectNoSeriousAxe(result.container);
  });

  it("should pass axe on audit", async () => {
    const vault = new FakeVault();
    const result = renderProjectPage(<AuditPage />, { vault });
    await screen.findByText("secret.read");
    await expectNoSeriousAxe(result.container);
  });

  it("should pass axe on the certificate list", async () => {
    const vault = new FakeVault();
    const result = renderProjectPage(<CertificatesPage />, {
      vault,
      path: "/projects/payments/certificates",
      route: "/projects/:project/certificates",
    });
    await screen.findByRole("link", { name: "api-tls" });
    await expectNoSeriousAxe(result.container);
  });

  it("should pass axe on certificate detail", async () => {
    const vault = new FakeVault();
    const result = renderProjectPage(<CertificateDetailPage />, {
      vault,
      path: "/projects/payments/certificates/api-tls",
      route: "/projects/:project/certificates/:name",
    });
    await screen.findByRole("heading", { name: "api-tls" });
    await expectNoSeriousAxe(result.container);
  });

  it("should pass axe on the application shell", async () => {
    const result = renderShell();
    await screen.findByRole("button", { name: "Open navigation" });
    await expectNoSeriousAxe(result.container);
  });
});
