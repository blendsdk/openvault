import { CommandLineParser } from "blendsdk/cmdline";
import { createAnonymousClient } from "../client/authenticated.js";
import { createTransportWithRuntime } from "../client/index.js";
import { readPassword } from "../credentials/password.js";
import { CredentialStore } from "../credentials/store.js";
import { CliError } from "../errors.js";
import { formatTable, formatTime } from "../output.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { createCommandContext, readVisibleLine } from "./context.js";

/** Returns one string option. */
function textOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

/** Returns one boolean option. */
function flagOption(options: Record<string, unknown>, name: string): boolean {
  return options[name] === true;
}

/**
 * Builds the auth group parser.
 *
 * @param globals - Global options.
 * @param runtime - Process boundary.
 * @returns The configured parser.
 */
export function createAuthParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const context = createCommandContext(globals, runtime);
  const parser = new CommandLineParser({
    name: "ov auth",
    version: "1.2.0",
    strict: true,
  });

  parser.addCommand({
    name: "login",
    description: "Log in with a local credential",
    options: [
      { name: "identifier", type: "string", description: "Email address or user name" },
      {
        name: "password-stdin",
        type: "boolean",
        description: "Read the password from standard input",
      },
    ],
    handler: async (options) => {
      const url = globals.url ?? runtime.env.OPENVAULT_URL;
      if (url === undefined || url.length === 0) {
        throw new CliError("usage_error", "Use --url or set OPENVAULT_URL", { exitCode: 2 });
      }
      const identifier =
        textOption(options, "identifier") ?? (await readVisibleLine(runtime, "Identifier: "));
      if (identifier.length === 0) {
        throw new CliError("validation_error", "The identifier is required", { exitCode: 2 });
      }
      const password = await readPassword({
        stdin: runtime.stdin,
        isTty: flagOption(options, "password-stdin") ? false : runtime.isTty,
        prompt: "Password: ",
        stderr: runtime.stderr,
      });
      const transport = createTransportWithRuntime(url, globals, runtime.env, runtime);
      const anonymous = createAnonymousClient(transport, url);
      const response = await anonymous.auth.loginCli({ identifier, password });
      const credentials = new CredentialStore({ env: runtime.env });
      await credentials.withLock(() => {
        credentials.save({
          version: 1,
          baseUrl: url,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          accessExpiresAt: response.accessExpiresAt,
          refreshExpiresAt: response.refreshExpiresAt,
        });
      });
      if (response.mustChangePassword) {
        runtime.stderr(
          "warning: the password must be changed before data commands are available\n",
        );
      }
      context.render(
        {
          user: response.user,
          mustChangePassword: response.mustChangePassword,
          accessExpiresAt: response.accessExpiresAt,
          refreshExpiresAt: response.refreshExpiresAt,
        },
        (value) =>
          `Logged in as ${value.user.name}${value.user.email === null ? "" : ` <${value.user.email}>`}`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "logout",
    description: "Revoke the current CLI session and remove local credentials",
    handler: async () => {
      const credentials = new CredentialStore({ env: runtime.env });
      let serverNotified = false;
      let warning: string | undefined;
      try {
        await credentials.withLock(async () => {
          const document = credentials.load();
          if (document !== undefined) {
            const transport = createTransportWithRuntime(
              document.baseUrl,
              globals,
              runtime.env,
              runtime,
            );
            const anonymous = createAnonymousClient(transport, document.baseUrl);
            try {
              await anonymous.auth.logoutCli({ refreshToken: document.refreshToken });
              serverNotified = true;
            } catch {
              warning =
                "The server was not notified; the session family may remain until it expires";
            }
          }
          credentials.remove();
        });
      } catch (error) {
        if (error instanceof CliError && error.code === "credential_store_locked") {
          // Never delete a file another process is actively refreshing.
          throw error;
        }
        if (error instanceof CliError && error.code.startsWith("credential_store_")) {
          try {
            credentials.forceRemove();
          } catch {
            throw error;
          }
          warning = error.message;
        } else {
          throw error;
        }
      }
      if (warning !== undefined) {
        runtime.stderr(`warning: ${warning}\n`);
      }
      context.render({ loggedOut: true, serverNotified }, () => "Logged out");
      return undefined;
    },
  });

  parser.addCommand({
    name: "whoami",
    description: "Show the current CLI user",
    handler: async () => {
      const { client } = await context.client();
      const me = await client.auth.getCliMe();
      if (me.mustChangePassword) {
        runtime.stderr(
          "warning: the password must be changed before data commands are available\n",
        );
      }
      context.render(
        me,
        (value) =>
          `${value.user.name}${value.user.email === null ? "" : ` <${value.user.email}>`} (${value.user.id})`,
      );
      return undefined;
    },
  });

  parser.addCommand({
    name: "sessions",
    description: "List or revoke CLI session families",
    options: [
      {
        name: "revoke",
        type: "string",
        description: "Revoke one family id",
      },
    ],
    handler: async (options) => {
      const { client } = await context.client();
      const revoke = textOption(options, "revoke");
      if (revoke === undefined) {
        const list = await client.auth.listCliSessions();
        context.render(list, (value) =>
          formatTable(
            ["ID", "CREATED", "EXPIRES", "CURRENT"],
            value.sessions.map((session) => [
              session.id,
              formatTime(session.createdAt),
              formatTime(session.expiresAt),
              session.current ? "yes" : "no",
            ]),
          ),
        );
        return undefined;
      }
      await context.confirm(`Revoke CLI session ${revoke}?`);
      await client.auth.revokeCliSession({ familyId: revoke });
      context.render({ revoked: revoke }, (value) => `Revoked ${value.revoked}`);
      return undefined;
    },
  });

  return parser;
}

/** The auth group definition. */
export const authGroup: CommandGroup = {
  name: "auth",
  summary: "Log in, log out, inspect the current user, and manage CLI sessions",
  commands: ["login", "logout", "whoami", "sessions"],
  createParser: createAuthParser,
};
