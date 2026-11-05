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
  Navigation20Regular,
  Person20Regular,
  SignOut20Regular,
  WeatherSunny20Regular,
} from "@fluentui/react-icons";
import { Link, Outlet, useNavigate } from "react-router";
import { useSessionApi } from "../session/session-api-provider.js";
import { useSession } from "../session/session-context.js";
import { useThemeMode } from "../theme/theme-root.js";

/**
 * The responsive application shell.
 *
 * The top bar is always present; the project section navigation lives in the
 * project route so it can show the current project. Narrow layouts hide the
 * sidebar and expose the same links through the navigation menu.
 */
export function AppShell() {
  const auth = useSession();
  const { client } = useSessionApi();
  const theme = useThemeMode();
  const navigate = useNavigate();
  const email = typeof auth.user?.email === "string" ? auth.user.email : undefined;
  const name = typeof auth.user?.name === "string" ? auth.user.name : "Account";

  const signOut = async (): Promise<void> => {
    try {
      await client.session.logoutSession();
    } catch {
      // Fall through to the local clear; the SDK also attempts a logout.
    }
    await auth.logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-bar">
        <div className="app-bar-left">
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                className="mobile-only"
                appearance="subtle"
                icon={<Navigation20Regular aria-hidden="true" />}
                aria-label="Open navigation"
              >
                Menu
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => navigate("/")}>Projects</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Link to="/" className="brand" aria-label="OpenVault home">
            <span className="brand-mark" aria-hidden="true">
              OV
            </span>
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
