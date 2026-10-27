// Run work for one key (a game, a session) one at a time inside this process. Writers to the same game queue here in memory instead of each
// holding a pooled database connection while they wait for the row lock, so a burst of retries from flaky connections cannot starve the
// pool. The database row lock still orders writers across processes; this only stops them piling up on connections.
import { AppError } from './errors.js';

const queues = new Map();

export async function serialized(key, fn, maxQueue = 100) {
  let q = queues.get(key);
  if (!q) { q = { tail: Promise.resolve(), n: 0 }; queues.set(key, q); }
  if (q.n >= maxQueue) throw new AppError(503, 'busy', 'Too many updates for this game at once; retry shortly', { retry_after_seconds: 1 });
  q.n++;
  const prev = q.tail;
  let release;
  q.tail = new Promise((r) => { release = r; });
  try {
    await prev;
    return await fn();
  } finally {
    q.n--; release();
    if (q.n === 0) queues.delete(key);
  }
}
