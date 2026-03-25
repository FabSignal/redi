import { pinoHttp } from "pino-http";

export const loggerMiddleware = pinoHttp({
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      "res.headers.set-cookie",
    ],
    censor: "[REDACTED]",
  },
});

export const appLogger = loggerMiddleware.logger;
