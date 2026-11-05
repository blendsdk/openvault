import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";

/** The supported theme modes. */
export type ThemeMode = "light" | "dark";

/** Theme state exposed to the app bar. */
export interface ThemeContextValue {
  /** Current mode. */
  readonly mode: ThemeMode;
  /** Switches between light and dark. */
  readonly toggle: () => void;
}

const THEME_KEY = "openvault.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads a stored mode without trusting arbitrary storage content. */
function initialMode(): ThemeMode {
  try {
    return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Stores only the non-sensitive theme preference. */
function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // A blocked storage API must not break the theme toggle.
  }
}

/**
 * Provides the Fluent theme and a mutable light/dark preference.
 *
 * This is the only local-storage write in the application. Secret values,
 * tokens, and session data never touch web storage.
 */
export function ThemeRoot({ children }: { readonly children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      toggle: () => {
        setMode((current) => {
          const next: ThemeMode = current === "light" ? "dark" : "light";
          storeMode(next);
          return next;
        });
      },
    }),
    [mode],
  );
  return (
    <ThemeContext.Provider value={value}>
      <FluentProvider theme={mode === "dark" ? webDarkTheme : webLightTheme}>
        <div className="app-root" data-theme={mode}>
          {children}
        </div>
      </FluentProvider>
    </ThemeContext.Provider>
  );
}

/** Returns the theme state. Throws outside `ThemeRoot`. */
export function useThemeMode(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useThemeMode must be used inside ThemeRoot");
  }
  return value;
}
