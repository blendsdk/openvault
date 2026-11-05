import type { CommandGroup } from "../types.js";
import { accessGroup } from "./access.js";
import { auditGroup } from "./audit.js";
import { authGroup } from "./auth.js";
import { backupGroup } from "./backup.js";
import { certGroup } from "./cert.js";
import { completionGroup } from "./completion.js";
import { dockerGroup } from "./docker.js";
import { doctorGroup } from "./doctor.js";
import { identityGroup } from "./identity.js";
import { initGroup } from "./init.js";
import { kekGroup } from "./kek.js";
import { projectGroup } from "./project.js";
import { restoreGroup } from "./restore.js";
import { roleGroup } from "./role.js";
import { runGroup } from "./run.js";
import { secretGroup } from "./secret.js";

/** Every command group in root-help order. */
export const GROUPS: readonly CommandGroup[] = [
  authGroup,
  projectGroup,
  secretGroup,
  certGroup,
  identityGroup,
  roleGroup,
  accessGroup,
  auditGroup,
  dockerGroup,
  runGroup,
  initGroup,
  backupGroup,
  restoreGroup,
  kekGroup,
  doctorGroup,
  completionGroup,
];
