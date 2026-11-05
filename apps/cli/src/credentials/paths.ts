import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { CliError } from "../errors.js";

/** One credential path set. */
export interface CredentialPaths {
  /** Directory that holds credentials and the lock. */
  readonly directory: string;
  /** Credential JSON path. */
  readonly file: string;
  /** Lock file path. */
  readonly lockFile: string;
}

/** Returns the current user's home directory. */
export function defaultHome(): string {
  return homedir();
}

/**
 * Resolves the credential path using the RD-11 precedence.
 *
 * @param env - Process environment.
 * @param platform - Node platform.
 * @param home - Home directory.
 * @returns Absolute directory, file, and lock paths.
 * @throws {CliError} When no safe path can be resolved.
 */
export function resolveCredentialPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = defaultHome(),
): CredentialPaths {
  let directory: string;
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0) {
    if (!isAbsolute(env.XDG_CONFIG_HOME)) {
      throw new CliError("credential_store_unavailable", "XDG_CONFIG_HOME must be absolute");
    }
    directory = join(env.XDG_CONFIG_HOME, "openvault");
  } else if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData === undefined || appData.length === 0 || !win32.isAbsolute(appData)) {
      throw new CliError("credential_store_unavailable", "APPDATA must be an absolute path");
    }
    directory = win32.join(appData, "openvault");
  } else if (platform === "darwin") {
    directory = join(home, "Library", "Application Support", "openvault");
  } else {
    directory = join(home, ".config", "openvault");
  }
  return {
    directory,
    file: join(directory, "credentials.json"),
    lockFile: join(directory, "credentials.lock"),
  };
}
