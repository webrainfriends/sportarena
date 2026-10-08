// Something just freed capacity at a venue (cancellation, released block): offer it to the waitlist first, then tell
// people with slot alerts about whatever is still free.
import { processWaitlist } from './waitlist.js';
import { checkSlotAlerts } from './alerts.js';

export const kickFreed = (venueId) => setImmediate(async () => {
  try { await processWaitlist({ venueId }); await checkSlotAlerts({ venueId }); } catch (e) { console.error('[freed]', e.message); }
});
