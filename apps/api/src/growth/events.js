// Versioned telemetry event definitions (#73). The registry is the contract between the apps and the server: an event that is not here, is the wrong
// version, names an entity type it may not, or carries a property it does not declare is not recorded. Properties are closed enums — no free text, no
// names, no addresses — and there is deliberately no event about health, clinical, medical, insurance, legal, guardian or youth records, so none can be
// sent: marketing telemetry cannot carry sensitive data because the schema has nowhere to put it.
//
// A change to what an event means or carries = a new `version` (old rows keep the version they were recorded under).
import { z } from 'zod';

const surface = z.enum(['home', 'search', 'map', 'share', 'notification', 'profile']);

/**
 * entities:  the entity types an event may refer to (a canonical record id, never a name).
 * reconcile: per entity type, the canonical check run later by reconcileEvents; null = not a claim about a record (nothing to verify).
 */
export const EVENTS = [
  { key: 'discovery_viewed', version: 1, label: 'Looked at a venue, game, event, coach or team', entities: ['venue', 'open_game', 'event', 'coach', 'team'], props: z.object({ surface }).strict(), reconcile: null },
  { key: 'search_performed', version: 1, label: 'Searched', entities: [], props: z.object({ surface, result_band: z.enum(['none', 'few', 'many']) }).strict(), reconcile: null },
  { key: 'booking_started', version: 1, label: 'Started a booking', entities: ['venue', 'open_game', 'event'], props: z.object({}).strict(), reconcile: null },
  { key: 'booking_completed', version: 1, label: 'Finished a booking', entities: ['reservation', 'booking'], props: z.object({}).strict(), reconcile: { reservation: 'reservation', booking: 'booking' } },
  { key: 'game_joined', version: 1, label: 'Joined an open game', entities: ['open_game'], props: z.object({}).strict(), reconcile: { open_game: 'open_game_member' } },
  { key: 'payment_started', version: 1, label: 'Started a payment', entities: ['payment'], props: z.object({}).strict(), reconcile: { payment: 'payment' } },
  { key: 'payment_failed', version: 1, label: 'A payment failed', entities: ['payment'], props: z.object({ reason: z.enum(['declined', 'cancelled', 'timeout', 'other']) }).strict(), reconcile: { payment: 'payment_failed' } },
  { key: 'invite_shared', version: 1, label: 'Shared an invitation', entities: [], props: z.object({ channel: z.enum(['link', 'message', 'qr']) }).strict(), reconcile: null },
];
export const eventByKey = (k) => EVENTS.find((e) => e.key === k);

/** Canonical record checks, each ($1 entity id, $2 person). A client's claim only counts as matched when the server's own record agrees. */
export const RECONCILERS = {
  reservation: "SELECT 1 FROM reservations WHERE id=$1 AND user_id=$2 AND status='confirmed'",
  booking: "SELECT 1 FROM bookings WHERE id=$1 AND user_id=$2 AND status='confirmed'",
  open_game_member: "SELECT 1 FROM open_game_members m WHERE m.open_game_id=$1 AND m.user_id=$2 AND m.status='confirmed'",
  payment: 'SELECT 1 FROM payments WHERE id=$1 AND payer_id=$2',
  payment_failed: "SELECT 1 FROM payments WHERE id=$1 AND payer_id=$2 AND status='failed'",
};

export const describeEvent = (e) => ({
  key: e.key, version: e.version, label: e.label, entity_types: e.entities, reconciles_to: e.reconcile ? 'a canonical record' : null,
  properties: Object.entries(e.props.shape).map(([name, t]) => ({ name, values: t.options ?? null })),
});
