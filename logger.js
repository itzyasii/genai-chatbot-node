// Lightweight logger for server-side use.
// Info/debug messages are conditional based on NODE_ENV and DEBUG env var.
const isDev = process.env.NODE_ENV !== "production";
const debugEnabled = process.env.DEBUG === "true";

export const debug = (...args) => {
  if (debugEnabled) {
    console.debug(...args);
  }
};

export const info = (...args) => {
  if (isDev || debugEnabled) {
    console.info(...args);
  }
};

export const warn = (...args) => {
  console.warn(...args);
};

export const error = (...args) => {
  console.error(...args);
};

export default { debug, info, warn, error };
