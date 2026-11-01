import type { Logger } from "blendsdk/webafx";
import type { AuthContext } from "../auth/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Request-scoped logger installed by the pino plugin. */
      log: Logger;
      /** Browser or CLI authentication context; absent for public requests. */
      auth?: AuthContext;
      /** CLI family id used only by the post-lookup refresh limiter. */
      cliRefreshFamilyId?: string;
    }
  }
}
