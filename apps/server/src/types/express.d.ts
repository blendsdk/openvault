import type { Logger } from "blendsdk/webafx";

declare global {
  namespace Express {
    interface Request {
      /** Request-scoped logger installed by the pino plugin. */
      log: Logger;
    }
  }
}
