import type { Logger } from "blendsdk/webafx";
import type { AgentAuthContext } from "../agent/types.js";
import type { AuthContext } from "../auth/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Request-scoped logger installed by the pino plugin. */
      log: Logger;
      /** Browser or CLI authentication context; absent for public requests. */
      auth?: AuthContext;
      /** Workload certificate context; present only on the agent listener. */
      agent?: AgentAuthContext;
      /** CLI family id used only by the post-lookup refresh limiter. */
      cliRefreshFamilyId?: string;
    }
  }
}
