const line = (level: string, msg: string) => `${new Date().toISOString()} ${level} tv-filter: ${msg}`;

export const log = {
  info: (msg: string) => console.log(line("INFO", msg)),
  warn: (msg: string) => console.warn(line("WARN", msg)),
  error: (msg: string) => console.error(line("ERROR", msg)),
};
