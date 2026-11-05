import type { TranslationLoader } from "blendsdk/react";

/** The English-only v0.1 catalog. */
const ENGLISH = {
  "app.name": "OpenVault",
  "app.tagline": "Secrets for your Compose projects",
  "nav.projects": "Projects",
  "nav.overview": "Overview",
  "nav.secrets": "Secrets",
  "nav.identities": "Identities",
  "nav.permissions": "Permissions",
  "nav.audit": "Audit",
  "nav.consumers": "Consumers",
  "action.signIn": "Sign in",
  "action.signOut": "Sign out",
  "action.refresh": "Refresh",
  "action.cancel": "Cancel",
  "action.save": "Save",
  "action.create": "Create",
  "action.delete": "Delete",
  "action.rename": "Rename",
  "action.retry": "Try again",
  "status.loading": "Loading…",
} as const;

/**
 * Loads one locale.
 *
 * Only English ships in v0.1; an unknown locale falls back to English so the
 * provider never shows raw keys.
 */
export const loadTranslations: TranslationLoader = async (locale) => {
  if (locale === "en") {
    return { ...ENGLISH };
  }
  return { ...ENGLISH };
};
