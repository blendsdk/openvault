import { ConfirmProvider, SystemErrorProvider } from "@blendsdk/fluentui-react-components";
import { AuthProvider, GlobalLoaderProvider, I18nProvider } from "blendsdk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { loadTranslations } from "./i18n.js";
import { SessionApiProvider } from "./session/session-api-provider.js";
import { SessionBridge } from "./session/session-context.js";
import { ThemeRoot } from "./theme/theme-root.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <ThemeRoot>
      <GlobalLoaderProvider>
        <I18nProvider loader={loadTranslations} defaultLocale="en">
          <AuthProvider
            config={{
              basePath: "/v1/auth",
              loginPath: "/login",
              defaultReturnTo: "/",
              autoRefresh: false,
            }}
          >
            <SessionBridge>
              <SessionApiProvider>
                <ConfirmProvider>
                  <SystemErrorProvider>
                    <BrowserRouter>
                      <App />
                    </BrowserRouter>
                  </SystemErrorProvider>
                </ConfirmProvider>
              </SessionApiProvider>
            </SessionBridge>
          </AuthProvider>
        </I18nProvider>
      </GlobalLoaderProvider>
    </ThemeRoot>
  </StrictMode>,
);
