import {
  AppLauncher,
  AppLauncherGrid,
  AppLauncherItem,
  AppLauncherList,
  AppLauncherSearch,
  AppLauncherSection,
} from "@blendsdk/fluentui-react-components";
import {
  Avatar,
  Button,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
} from "@fluentui/react-components";
import {
  DarkTheme20Regular,
  DocumentBulletList20Regular,
  Folder20Regular,
  Home20Regular,
  Key20Regular,
  Person20Regular,
  PlugConnected20Regular,
  Shield20Regular,
  SignOut20Regular,
  WeatherSunny20Regular,
} from "@fluentui/react-icons";
import type { ReactElement } from "react";
import { useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { BrandMark } from "../components/brand.js";
import { useSessionApi } from "../session/session-api-provider.js";
import { useSession } from "../session/session-context.js";
import { useThemeMode } from "../theme/theme-root.js";

/** One destination in the application launcher. */
interface LauncherEntry {
  /** Visible label and accessible name. */
  readonly label: string;
  /** Route to open. */
  readonly to: string;
  /** Decorative icon shown beside or above the label. */
  readonly icon: ReactElement;
  /** Extra search words that are not part of the label. */
  readonly keywords: string;
  /** Whether the destination is active only on an exact path match. */
  readonly exact: boolean;
}

/**
 * Returns the project name encoded in a project route.
 *
 * `AppShell` renders above `ProjectRoute`, so it cannot use the project
 * context. The URL is the only source of truth here; a malformed escape is
 * treated as "not in a project" rather than throwing during render.
 *
 * @param pathname - Current router path.
 * @returns The decoded project name, or `undefined` outside a project route.
 */
function projectNameFromPath(pathname: string): string | undefined {
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  const encoded = match?.[1];
  if (encoded === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** Builds the launcher destinations for the current route. */
function launcherEntries(projectName: string | undefined): LauncherEntry[] {
  const entries: LauncherEntry[] = [
    {
      label: "Projects",
      to: "/",
      icon: <Folder20Regular aria-hidden="true" />,
      keywords: "home workspace",
      exact: true,
    },
  ];
  if (projectName === undefined) {
    return entries;
  }
  const base = `/projects/${encodeURIComponent(projectName)}`;
  entries.push(
    {
      label: "Overview",
      to: base,
      icon: <Home20Regular aria-hidden="true" />,
      keywords: "project summary",
      exact: true,
    },
    {
      label: "Secrets",
      to: `${base}/secrets`,
      icon: <Key20Regular aria-hidden="true" />,
      keywords: "values credentials",
      exact: false,
    },
    {
      label: "Identities",
      to: `${base}/identities`,
      icon: <Person20Regular aria-hidden="true" />,
      keywords: "services agents",
      exact: false,
    },
    {
      label: "Permissions",
      to: `${base}/permissions`,
      icon: <Shield20Regular aria-hidden="true" />,
      keywords: "roles grants access",
      exact: false,
    },
    {
      label: "Audit",
      to: `${base}/audit`,
      icon: <DocumentBulletList20Regular aria-hidden="true" />,
      keywords: "events chain history",
      exact: false,
    },
    {
      label: "Consumers",
      to: `${base}/consumers`,
      icon: <PlugConnected20Regular aria-hidden="true" />,
      keywords: "services agents delivery",
      exact: false,
    },
  );
  return entries;
}

/** Returns true when the destination owns the current path. */
function isCurrent(pathname: string, entry: LauncherEntry): boolean {
  if (entry.exact) {
    return pathname === entry.to || pathname === `${entry.to}/`;
  }
  return pathname === entry.to || pathname.startsWith(`${entry.to}/`);
}

/**
 * The responsive application shell.
 *
 * The top bar is always present. The app launcher is the global navigation
 * control at every width: it lists Projects everywhere and adds the current
 * project's sections inside a project route. The project section navigation
 * stays visible below the project header, so the launcher is a shortcut
 * rather than the only way to move around.
 */
export function AppShell() {
  const auth = useSession();
  const { client } = useSessionApi();
  const theme = useThemeMode();
  const navigate = useNavigate();
  const location = useLocation();
  const barRef = useRef<HTMLElement>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherPath, setLauncherPath] = useState(location.pathname);
  const [query, setQuery] = useState("");
  const email = typeof auth.user?.email === "string" ? auth.user.email : undefined;
  const name = typeof auth.user?.name === "string" ? auth.user.name : "Account";
  const projectName = projectNameFromPath(location.pathname);
  const entries = useMemo(() => launcherEntries(projectName), [projectName]);
  const needle = query.trim().toLowerCase();
  const visibleEntries =
    needle === ""
      ? entries
      : entries.filter((entry) =>
          `${entry.label} ${entry.keywords}`.toLowerCase().includes(needle),
        );

  // A route change ends the launcher interaction. Deriving the value from the
  // path keeps browser back/forward from leaving a stale panel open without an
  // effect that would only reset state after the new page renders.
  const isLauncherOpen = launcherOpen && launcherPath === location.pathname;

  const signOut = async (): Promise<void> => {
    try {
      await client.session.logoutSession();
    } catch {
      // Fall through to the local clear; the SDK also attempts a logout.
    }
    await auth.logout();
    navigate("/login", { replace: true });
  };

  const go = (to: string): void => {
    setLauncherOpen(false);
    setQuery("");
    navigate(to);
  };

  const renderEntry = (entry: LauncherEntry): ReactElement => (
    <AppLauncherItem
      key={entry.to}
      label={entry.label}
      icon={entry.icon}
      aria-current={isCurrent(location.pathname, entry) ? "page" : undefined}
      onClick={() => go(entry.to)}
    />
  );

  const globalEntries = entries.filter((entry) => entry.to === "/");
  const projectEntries = entries.filter((entry) => entry.to !== "/");

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-bar" ref={barRef}>
        <div className="app-bar-left">
          <AppLauncher
            label="Open navigation"
            dockTarget={barRef}
            positioning={{ align: "start", position: "below" }}
            open={isLauncherOpen}
            onOpenChange={(_event, data) => {
              if (data.open) {
                setLauncherPath(location.pathname);
                setQuery("");
                setLauncherOpen(true);
              } else {
                setLauncherOpen(false);
              }
            }}
          >
            <AppLauncherSearch
              label="Search navigation"
              placeholder="Search"
              value={query}
              onChange={(_event, data) => setQuery(data.value)}
            />
            {needle === "" ? (
              projectName === undefined ? (
                <AppLauncherSection title="Navigate">
                  <AppLauncherGrid>{globalEntries.map(renderEntry)}</AppLauncherGrid>
                </AppLauncherSection>
              ) : (
                <>
                  <AppLauncherSection title="Navigate">
                    <AppLauncherGrid>{globalEntries.map(renderEntry)}</AppLauncherGrid>
                  </AppLauncherSection>
                  <AppLauncherSection title={projectName} divider>
                    <AppLauncherGrid>{projectEntries.map(renderEntry)}</AppLauncherGrid>
                  </AppLauncherSection>
                </>
              )
            ) : visibleEntries.length === 0 ? (
              <AppLauncherSection>
                <p className="launcher-empty">No destinations match “{query.trim()}”.</p>
              </AppLauncherSection>
            ) : (
              <AppLauncherSection title="Results">
                <AppLauncherList>{visibleEntries.map(renderEntry)}</AppLauncherList>
              </AppLauncherSection>
            )}
          </AppLauncher>
          <Link to="/" className="brand" aria-label="OpenVault home">
            <BrandMark />
            <span className="brand-name">OpenVault</span>
          </Link>
        </div>
        <div className="app-bar-right">
          <Button
            appearance="subtle"
            icon={
              theme.mode === "dark" ? (
                <WeatherSunny20Regular aria-hidden="true" />
              ) : (
                <DarkTheme20Regular aria-hidden="true" />
              )
            }
            onClick={theme.toggle}
            aria-label={theme.mode === "dark" ? "Use light theme" : "Use dark theme"}
          >
            <span className="desktop-only">{theme.mode === "dark" ? "Light" : "Dark"}</span>
          </Button>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                icon={<Avatar name={name} size={24} />}
                aria-label="Account"
              >
                <span className="desktop-only">{name}</span>
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem disabled icon={<Person20Regular aria-hidden="true" />}>
                  {email ?? name}
                </MenuItem>
                <MenuItem
                  icon={<SignOut20Regular aria-hidden="true" />}
                  onClick={() => void signOut()}
                >
                  Sign out
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </header>
      <div className="app-body">
        <aside className="app-sidebar">
          <nav aria-label="Main navigation">
            <Link to="/" className="sidebar-link">
              Projects
            </Link>
          </nav>
          <div className="sidebar-footer">
            <Text size={200} className="muted">
              OpenVault 0.1
            </Text>
          </div>
        </aside>
        <main id="main-content" className="app-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
