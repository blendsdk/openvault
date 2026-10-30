import type { Logger } from "blendsdk/webafx";
import type { AuthContext } from "../auth/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Request-scoped logger installed by the pino plugin. */
      log: Logger;
      /** Authenticated session context; absent for public or machine requests. */
      auth?: AuthContext;
    }
  }
}
