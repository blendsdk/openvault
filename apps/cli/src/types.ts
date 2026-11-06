import type { CommandLineParser } from "blendsdk/cmdline";

/** One parsed global option set. */
export interface GlobalOptions {
  /** Machine-readable output. */
  readonly json: boolean;
  /** Skip destructive confirmations. */
  readonly yes: boolean;
  /** Structured request events on stderr. */
  readonly verbose: boolean;
  /** Project context. */
  readonly project?: string;
  /** Organization context, reserved for a later release. */
  readonly org?: string;
  /** CA bundle path. */
  readonly ca?: string;
  /** Server base URL override. */
  readonly url?: string;
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** The process boundary used by the CLI. */
export interface CliRuntime {
  /** Process environment. */
  readonly env: NodeJS.ProcessEnv;
  /** Current working directory. */
  readonly cwd: string;
  /** Standard output writer. */
  readonly stdout: (text: string) => void;
  /** Standard error writer. */
  readonly stderr: (text: string) => void;
  /** Standard input. */
  readonly stdin: NodeJS.ReadableStream & {
    readonly isTTY?: boolean;
    setRawMode?(mode: boolean): void;
    resume?(): void;
    pause?(): void;
  };
  /** Whether the invocation has an interactive terminal. */
  readonly isTty: boolean;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Injected bootstrap function for tests. */
  readonly runInit?: (
    options: import("@openvault/server/init").InitOptions,
  ) => Promise<import("@openvault/server/init").InitResult>;
  /** Injected backup function for tests. */
  readonly runBackup?: (
    options: import("@openvault/server/ops").BackupOptions,
  ) => Promise<import("@openvault/server/ops").BackupResult>;
  /** Injected restore function for tests. */
  readonly runRestore?: (
    options: import("@openvault/server/ops").RestoreOptions,
  ) => Promise<import("@openvault/server/ops").RestoreResult>;
  /** Injected KEK rotation function for tests. */
  readonly runKekRotate?: (
    options: import("@openvault/server/ops").KekRotateOptions,
  ) => Promise<import("@openvault/server/ops").KekRotateResult>;
  /** Injected audit-checkpoint export function for tests. */
  readonly runCheckpointExport?: (
    options: import("@openvault/server/ops").CheckpointExportOptions,
  ) => Promise<import("@openvault/server/ops").CheckpointExportResult>;
}

/** One command group. */
export interface CommandGroup {
  /** Group name shown in root help. */
  readonly name: string;
  /** One-line summary. */
  readonly summary: string;
  /** Commands shown in root help. */
  readonly commands: readonly string[];
  /** Builds the group parser. */
  readonly createParser: (globals: GlobalOptions, runtime: CliRuntime) => CommandLineParser;
}
