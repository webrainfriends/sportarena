// Admin view of the durable job queue / dead-letter registry. Payloads are never returned (they can contain message text);
// each row carries the id of the record it concerns (credit note, delivery or user) instead.
import { z } from 'zod';
import { cap, id, page } from '../registry.js';
import { conflict, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { listJobs, requeueJob } from '../jobs.js';

const TAG = 'Operations';

cap({
  name: 'list_jobs', method: 'GET', path: '/admin/jobs', tag: TAG, auth: ['admin'],
  summary: 'Platform team: background jobs and dead letters (refunds, email/push deliveries and notifications that exhausted their retries). Filter by status (default `dead`) and category. Newest first.',
  input: z.object({ status: z.enum(['queued', 'running', 'succeeded', 'dead', 'requeued']).default('dead'), category: z.string().max(40).optional(), ...page }),
  async handler(_, i) { return listJobs(i); },
});

cap({
  name: 'requeue_job', method: 'POST', path: '/admin/jobs/:id/requeue', tag: TAG, auth: ['admin'],
  summary: 'Platform team: send a dead-lettered job back for processing with a fresh retry budget. Refunds keep any money-movement intent already recorded, so a requeue can never refund twice.',
  input: z.object({ id }),
  async handler({ user }, i) {
    const r = await requeueJob(i.id);
    if (r.error === 'not_found') throw notFound('Job');
    if (r.error === 'not_dead') throw conflict('Only dead-lettered jobs can be requeued');
    await audit(null, user.id, 'requeue_job', 'jobs', i.id);
    const { payload, ...job } = r.job;
    return job;
  },
});
