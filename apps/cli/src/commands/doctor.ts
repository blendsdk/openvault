import { CommandLineParser } from "blendsdk/cmdline";
import { createTransportWithRuntime } from "../client/index.js";
import { CredentialStore } from "../credentials/store.js";
import { CliError, CliExit } from "../errors.js";
import { formatTable } from "../output.js";
import type { HttpsAdapter } from "../transport/https-adapter.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";

/** One doctor check. */
interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Builds the doctor group parser. */
export function createDoctorParser(globals: GlobalOptions, runtime: CliRuntime): CommandLineParser {
  const parser = new CommandLineParser({ name: "ov doctor", version: "0.1.0", strict: true });
  parser.addCommand({
    name: "doctor",
    description: "Check API reachability, TLS trust, credentials, and clock skew",
    handler: async () => {
      const checks: DoctorCheck[] = [];
      let store: CredentialStore | undefined;
      try {
        store = new CredentialStore({ env: runtime.env });
      } catch (error) {
        checks.push({
          name: "credentials",
          ok: false,
          detail: error instanceof Error ? error.message : "credential store unavailable",
        });
      }
      let baseUrl = globals.url ?? runtime.env.OPENVAULT_URL;
      if (baseUrl === undefined && store !== undefined) {
        try {
          baseUrl = store.load()?.baseUrl;
        } catch {
          baseUrl = undefined;
        }
      }
      if (baseUrl === undefined) {
        checks.push({ name: "readiness", ok: false, detail: "no server URL" });
        checks.push({ name: "clock", ok: false, detail: "no server URL" });
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
          transport = undefined;
        }
        if (transport !== undefined) {
          try {
            const ready = await transport.probe("/ready");
            checks.push({
              name: "readiness",
              ok: ready.ok,
              detail: ready.ok ? "ready" : `status ${ready.status}`,
            });
            const date = ready.headers.date;
            if (typeof date === "string") {
              const skew = Math.abs(Date.now() - Date.parse(date));
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
              name: "readiness",
              ok: false,
              detail: error instanceof Error ? error.message : "readiness failed",
            });
            checks.push({ name: "clock", ok: false, detail: "readiness failed" });
          }
          if (store !== undefined) {
            try {
              const document = store.load();
              if (document === undefined) {
                checks.push({
                  name: "credentials",
                  ok: false,
                  detail: "run ov login",
                });
              } else {
                const me = await transport.probe("/v1/auth/cli/me", {
                  Authorization: `Bearer ${document.accessToken}`,
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
  summary: "Check API, TLS, credentials, and clock skew",
  commands: ["doctor"],
  createParser: createDoctorParser,
};
