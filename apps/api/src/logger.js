// Structured JSON logs with correlation ids. One line per event on stdout/stderr (pm2 and Docker collect them).
// The current request id / job id / worker id are attached automatically through AsyncLocalStorage.
// Never log request bodies, tokens, passwords or personal data: pass ids only. Keys that look sensitive are dropped as a safety net.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const SENSITIVE = /pass|token|secret|authorization|cookie|email|phone|body|payload|national|dob|address|card/i;

export const runWithContext = (ctx, fn) => als.run({ ...(als.getStore() ?? {}), ...ctx }, fn);
export const currentContext = () => als.getStore() ?? {};

export function log(level, msg, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg, ...currentContext() };
  for (const [k, v] of Object.entries(fields)) if (!SENSITIVE.test(k)) line[k] = v;
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(out); else console.log(out);
}
export const logger = { info: (m, f) => log('info', m, f), warn: (m, f) => log('warn', m, f), error: (m, f) => log('error', m, f) };
