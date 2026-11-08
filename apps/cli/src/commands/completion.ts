import { CommandLineParser } from "blendsdk/cmdline";
import { CliError } from "../errors.js";
import type { CliRuntime, CommandGroup, GlobalOptions } from "../types.js";
import { requiredText } from "./options.js";

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  auth: ["login", "logout", "whoami", "sessions"],
  project: ["list", "create", "delete"],
  secret: ["set", "get", "list", "versions", "delete", "recover", "purge"],
  cert: ["import", "generate", "get", "list", "delete"],
  identity: ["create", "list", "revoke", "join-token"],
  role: ["grant", "revoke"],
  access: ["explain"],
  audit: ["list", "verify", "export", "checkpoint"],
  docker: ["scaffold"],
  run: ["run"],
  init: ["init"],
  backup: ["backup"],
  restore: ["restore"],
  kek: ["rotate"],
  doctor: ["doctor"],
  completion: ["completion"],
};

/** Renders one static completion script. */
function script(shell: string): string {
  const words = [...Object.keys(COMMANDS), ...Object.values(COMMANDS).flat()];
  const unique = [...new Set(words)].sort();
  if (shell === "bash") {
    return `# bash completion for ov\n_ov_complete() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  COMPREPLY=( $(compgen -W "${unique.join(" ")}" -- "$cur") )\n}\ncomplete -F _ov_complete ov\n`;
  }
  if (shell === "zsh") {
    return `# zsh completion for ov\n_ov() {\n  local -a commands\n  commands=(${unique.map((word) => `"${word}"`).join(" ")})\n  _describe 'command' commands\n}\ncompdef _ov ov\n`;
  }
  if (shell === "fish") {
    return `${unique.map((word) => `complete -c ov -f -a "${word}"`).join("\n")}\n`;
  }
  throw new CliError("usage_error", "Shell must be bash, zsh, or fish", { exitCode: 2 });
}

/** Builds the completion group parser. */
export function createCompletionParser(
  _globals: GlobalOptions,
  runtime: CliRuntime,
): CommandLineParser {
  const parser = new CommandLineParser({
    name: "ov completion",
    version: "1.1.0",
    strict: true,
  });
  parser.addCommand({
    name: "completion",
    description: "Print a static shell completion script",
    options: [
      {
        name: "shell",
        type: "string",
        required: true,
        choices: ["bash", "zsh", "fish"],
        description: "Target shell",
      },
    ],
    handler: (options) => {
      runtime.stdout(script(requiredText(options, "shell")));
      return undefined;
    },
  });
  return parser;
}

/** The completion group definition. */
export const completionGroup: CommandGroup = {
  name: "completion",
  summary: "Print a static bash, zsh, or fish completion script",
  commands: ["completion"],
  createParser: createCompletionParser,
};
