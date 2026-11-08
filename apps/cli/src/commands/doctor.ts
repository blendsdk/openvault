import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeDatabase, probeKeyring } from "@openvault/server/ops";
import { CommandLineParser } from "blendsdk/cmdline";
import { sameCredentialOrigin } from "../client/authenticated.js";
import { createTransportWithRuntime } from "../client/index.js";
import { CredentialStore } from "../credentials/store.js";
import { CliError, CliExit } from "../errors.js";
import { formatTable } from "../output.js";
import type { HttpsAdapter } from "../transport/https-adapter.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { databaseUrlFromEnv } from "./database-url.js";
import { textOption } from "./options.js";

/** One doctor check. */
interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Result of the backup-age check. */
export interface BackupAgeCheck {
  /** True when a recent archive exists. */
  readonly ok: boolean;
  /** Human-readable age or reason. */
  readonly detail: string;
}

/** Default recovery point objective. */
const RPO_MS = 24 * 3_600_000;

/**
 * Checks the newest age archive in a backup directory against the 24-hour RPO.
 *
 * @param directory - Directory that contains backup archives.
 * @param nowMs - Current clock in milliseconds.
 * @param maxAgeMs - Allowed age; defaults to 24 hours.
 * @returns Whether a recent archive exists.
 */
export function checkBackupAge(
  directory: string,
  nowMs: number,
  maxAgeMs = RPO_MS,
): BackupAgeCheck {
  const absolute = resolve(directory);
  if (!existsSync(absolute)) {
    return { ok: false, detail: "backup directory does not exist" };
  }
  let names: string[];
  try {
    names = readdirSync(absolute).filter((name) => name.endsWith(".age"));
  } catch {
    return { ok: false, detail: "backup directory is not readable" };
  }
  if (names.length === 0) {
    return { ok: false, detail: "no .age backup archive found" };
  }
  let newest = 0;
  for (const name of names) {
    try {
      const stats = statSync(join(absolute, name));
      if (stats.isFile()) {
        newest = Math.max(newest, stats.mtimeMs);
      }
    } catch {
      // Ignore an archive that disappeared during the scan.
    }
  }
  if (newest === 0) {
    return { ok: false, detail: "no readable backup archive found" };
  }
  const age = Math.max(0, nowMs - newest);
  if (age > maxAgeMs) {
    const hours = Math.floor(age / 3_600_000);
    return { ok: false, detail: `newest backup is ${hours}h old (RPO 24h)` };
  }
  const hours = Math.floor(age / 3_600_000);
  return {
    ok: true,
    detail: hours < 1 ? "newest backup is under 1h old" : `newest backup is ${hours}h old`,
  };
}

/** Builds the doctor group parser. */
export function createDoctorParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const parser = new CommandLineParser({ name: "ov doctor", version: "1.0.1", strict: true });
  parser.addCommand({
    name: "doctor",
    description:
      "Check API reachability, TLS trust, credentials, database, keyring, clock, and backup age",
    options: [
      {
        name: "backup-dir",
        type: "string",
        description: "Directory containing .age backups (default: OPENVAULT_BACKUP_DIR)",
      },
    ],
    handler: async (options) => {
      const checks: DoctorCheck[] = [];
      let store: CredentialStore | undefined;
      let credential: ReturnType<CredentialStore["load"]> | undefined;
      try {
        store = new CredentialStore({ env: runtime.env });
        credential = store.load();
      } catch (error) {
        checks.push({
          name: "credentials",
          ok: false,
          detail: error instanceof Error ? error.message : "credential store unavailable",
        });
      }

      let databaseUrl: string | undefined;
      try {
        databaseUrl = databaseUrlFromEnv(runtime, "OPENVAULT_DB_URL", false);
      } catch (error) {
        checks.push({
          name: "database",
          ok: false,
          detail: error instanceof CliError ? error.message : "database configuration is invalid",
        });
      }
      if (databaseUrl !== undefined) {
        const probe = await probeDatabase(databaseUrl);
        checks.push({ name: "database", ok: probe.ok, detail: probe.detail });
      } else if (!checks.some((check) => check.name === "database")) {
        checks.push({ name: "database", ok: true, detail: "not configured (skipped)" });
      }

      const keyringPath = runtime.env.OPENVAULT_KEYRING;
      if (keyringPath === undefined || keyringPath.trim().length === 0) {
        checks.push({ name: "keyring", ok: true, detail: "not configured (skipped)" });
      } else {
        const probe = await probeKeyring(keyringPath);
        checks.push({ name: "keyring", ok: probe.ok, detail: probe.detail });
      }

      const backupDirectory = textOption(options, "backup-dir") ?? runtime.env.OPENVAULT_BACKUP_DIR;
      if (backupDirectory === undefined || backupDirectory.trim().length === 0) {
        checks.push({ name: "backup", ok: true, detail: "not configured (skipped)" });
      } else {
        const backup = checkBackupAge(backupDirectory, (runtime.now ?? Date.now)());
        checks.push({ name: "backup", ok: backup.ok, detail: backup.detail });
      }

      let baseUrl = globals.url ?? runtime.env.OPENVAULT_URL;
      if (baseUrl === undefined && credential !== undefined) {
        baseUrl = credential.baseUrl;
      }
      if (baseUrl === undefined) {
        checks.push({ name: "tls", ok: false, detail: "no server URL" });
        checks.push({ name: "readiness", ok: false, detail: "no server URL" });
        checks.push({ name: "clock", ok: false, detail: "no server URL" });
        if (store !== undefined && credential === undefined) {
          checks.push({
            name: "credentials",
            ok: false,
            detail: "credential store is unavailable or malformed; run ov login",
          });
        }
      } else {
        let transport: HttpsAdapter | undefined;
        try {
          transport = createTransportWithRuntime(baseUrl, globals, runtime.env, runtime);
        } catch (error) {
          checks.push({
            name: "tls",
            ok: false,
            detail: error instanceof Error ? error.message : "invalid TLS configuration",
          });
          checks.push({ name: "readiness", ok: false, detail: "TLS configuration failed" });
          checks.push({ name: "clock", ok: false, detail: "TLS configuration failed" });
          transport = undefined;
        }
        if (transport !== undefined) {
          try {
            const ready = await transport.probe("/ready");
            // Any HTTP response proves the TLS handshake and certificate trust
            // succeeded; the readiness status is evaluated separately.
            checks.push({ name: "tls", ok: true, detail: "certificate trusted" });
            checks.push({
              name: "readiness",
              ok: ready.ok,
              detail: ready.ok ? "ready" : `status ${ready.status}`,
            });
            const date = ready.headers.date;
            if (typeof date === "string") {
              const skew = Math.abs((runtime.now ?? Date.now)() - Date.parse(date));
              checks.push({
                name: "clock",
                ok: skew <= 300_000,
                detail:
                  skew > 60_000 ? `clock skew ${Math.round(skew / 1_000)}s` : "within tolerance",
              });
            } else {
              checks.push({ name: "clock", ok: false, detail: "no Date header" });
            }
          } catch (error) {
            checks.push({
              name: "tls",
              ok: false,
              detail: error instanceof Error ? error.message : "TLS probe failed",
            });
            checks.push({ name: "readiness", ok: false, detail: "readiness failed" });
            checks.push({ name: "clock", ok: false, detail: "readiness failed" });
          }
          if (store !== undefined) {
            try {
              if (credential === undefined) {
                checks.push({
                  name: "credentials",
                  ok: false,
                  detail: "run ov login",
                });
              } else if (!sameCredentialOrigin(baseUrl, credential.baseUrl)) {
                // The selected probe origin belongs to a different server. TLS
                // and readiness remain useful unauthenticated checks, but the
                // stored bearer must never leave its original origin.
                checks.push({
                  name: "credentials",
                  ok: false,
                  detail:
                    "stored credential belongs to a different server; run ov login for this origin",
                });
              } else {
                const me = await transport.probe("/v1/auth/cli/me", {
                  Authorization: `Bearer ${credential.accessToken}`,
                });
                checks.push({
                  name: "credentials",
                  ok: me.ok,
                  detail: me.ok ? "valid" : `status ${me.status}`,
                });
              }
            } catch (error) {
              checks.push({
                name: "credentials",
                ok: false,
                detail: error instanceof Error ? error.message : "credential check failed",
              });
            }
          }
        }
      }
      const ok = checks.every((check) => check.ok);
      if (globals.json) {
        runtime.stdout(`${JSON.stringify({ success: true, data: { ok, checks } })}\n`);
        if (!ok) {
          throw new CliExit(1);
        }
      } else {
        runtime.stdout(
          `${formatTable(
            ["CHECK", "OK", "DETAIL"],
            checks.map((check) => [check.name, check.ok ? "yes" : "no", check.detail]),
          )}\n`,
        );
      }
      if (!ok) {
        throw new CliError("doctor_failed", "One or more doctor checks failed", {
          exitCode: 1,
          details: { checks },
        });
      }
      return undefined;
    },
  });
  return parser;
}

/** The doctor group definition. */
export const doctorGroup: CommandGroup = {
  name: "doctor",
  summary: "Check API, TLS, database, keyring, backup age, credentials, and clock skew",
  commands: ["doctor"],
  createParser: createDoctorParser,
};
