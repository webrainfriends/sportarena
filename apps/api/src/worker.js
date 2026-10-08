// Background maintenance: reminders + queued email, release of unpaid holds, credit-note refunds.
import { notificationCycle } from './notify.js';
import { expireUnpaidHolds } from './booking/holds.js';
import { processRefunds } from './booking/refunds.js';

export async function maintenanceCycle() {
  const holds = await expireUnpaidHolds();
  const refunds = await processRefunds();
  return { holds_released: holds, refunds, ...(await notificationCycle()) };
}
