export const logger = {
  info(message: string, data?: unknown) {
    console.error(format("info", message, data));
  },
  warn(message: string, data?: unknown) {
    console.error(format("warn", message, data));
  },
  error(message: string, data?: unknown) {
    console.error(format("error", message, data));
  }
};

function format(level: string, message: string, data?: unknown): string {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  return `[project-memory:${level}] ${message}${suffix}`;
}
