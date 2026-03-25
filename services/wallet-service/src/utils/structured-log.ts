import { appLogger } from "../logger.js";

type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, component: string, event: string, fields: Record<string, unknown>): void {
  appLogger[level](
    {
      component,
      event,
      ...fields,
    },
    event,
  );
}

export const structuredLog = {
  debug(component: string, event: string, fields: Record<string, unknown> = {}): void {
    write("debug", component, event, fields);
  },
  info(component: string, event: string, fields: Record<string, unknown> = {}): void {
    write("info", component, event, fields);
  },
  warn(component: string, event: string, fields: Record<string, unknown> = {}): void {
    write("warn", component, event, fields);
  },
  error(component: string, event: string, fields: Record<string, unknown> = {}): void {
    write("error", component, event, fields);
  },
};
