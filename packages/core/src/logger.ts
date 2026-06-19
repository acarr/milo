import pino from "pino";

const level = process.env.MILO_LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
