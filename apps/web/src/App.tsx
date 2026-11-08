import { AuthGuard } from "blendsdk/react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./layout/app-shell.js";
import { AuditPage } from "./pages/audit-page.js";
import { CertificateDetailPage } from "./pages/certificate-detail-page.js";
import { CertificatesPage } from "./pages/certificates-page.js";
import { ChangePasswordPage } from "./pages/change-password-page.js";
import { ConsumersPage } from "./pages/consumers-page.js";
import { IdentitiesPage } from "./pages/identities-page.js";
import { LoginPage } from "./pages/login-page.js";
import { NotFoundPage } from "./pages/not-found-page.js";
import { PermissionsPage } from "./pages/permissions-page.js";
import { ProjectOverviewPage } from "./pages/project-overview-page.js";
import { ProjectsPage } from "./pages/projects-page.js";
import { SecretDetailPage } from "./pages/secret-detail-page.js";
import { SecretsPage } from "./pages/secrets-page.js";
import { ProjectRoute } from "./projects/project-route.js";
import { PasswordGate } from "./session/password-gate.js";

/** The application route tree. */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<PasswordGate />}>
        <Route element={<AuthGuard />}>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<AppShell />}>
            <Route index element={<ProjectsPage />} />
            <Route path="projects/:project" element={<ProjectRoute />}>
              <Route index element={<ProjectOverviewPage />} />
              <Route path="secrets" element={<SecretsPage />} />
              <Route path="secrets/:name" element={<SecretDetailPage />} />
              <Route path="certificates" element={<CertificatesPage />} />
              <Route path="certificates/:name" element={<CertificateDetailPage />} />
              <Route path="identities" element={<IdentitiesPage />} />
              <Route path="permissions" element={<PermissionsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="consumers" element={<ConsumersPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
