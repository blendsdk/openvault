import type { OpenVaultWebClient } from "../generated/index.js";

/** Secret metadata used by the rotation card and dialogs. */
export type RotationSecret = Awaited<
  ReturnType<OpenVaultWebClient["secrets"]["listSecrets"]>
>["secrets"][number];
