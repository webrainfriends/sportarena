// Token scopes: every capability is classified once, here, and invoke() enforces the class for API-token credentials.
// Effective permission = (what the token's scopes allow) AND (what the user's roles/ownership allow) - both always apply.
import { forbidden } from './errors.js';

export const SCOPES = ['read', 'write', 'payment', 'clinical', 'admin'];
export const LEGACY_SCOPE = 'full'; // migrated pre-scope tokens only; never accepted on creation
export const RESOURCE_TYPES = ['venue', 'team', 'event', 'organisation'];

const PAYMENT = new Set([
  'create_payment', 'confirm_payment', 'refund_payment', 'topup_wallet', 'apply_wallet_to_invoice', 'adjust_wallet', 'buy_gift_card', 'redeem_gift_card',
  'redeem_points', 'exchange_loyalty_points', 'buy_plan', 'apply_pass_to_invoice', 'mark_invoice_paid', 'mark_credit_note_refunded', 'buy_product', 'buy_policy',
  'accept_quote', 'renew_policy', 'file_claim', 'create_team_payout', 'create_squad_payouts', 'update_team_payout', 'set_booking_payment',
  'set_academy_charge_funding', 'adjust_academy_charge', 'refund_academy_charge', 'record_academy_payment', 'record_budget_payment', 'void_budget_payment', 'record_staff_payment', 'report_sponsorship_payment', 'request_sponsorship_refund', 'decide_sponsorship_refund', 'generate_settlement', 'add_settlement_adjustment', 'decide_settlement',
  'fund_ad_campaign', 'refund_ad_balance', 'record_team_payment', 'adjust_team_charge', 'cancel_team_charge', 'create_team_charges', 'create_team_expense', 'create_team_dues_plan', 'record_team_contribution', 'contribute_to_team_fundraiser',
  'create_payout_run', 'approve_payout_run', 'export_payout_run', 'record_payout_line_result', 'cancel_payout_run', 'add_contract_adjustment', 'record_contract_refund', 'issue_contract_credit_note', 'decide_contract_expense', 'submit_contract_expense',
]);
// Credential / role management must not be reachable with a narrow token (otherwise a read token could mint a wider one).
const ACCOUNT = new Set(['create_api_token', 'revoke_api_token', 'list_api_tokens', 'update_my_roles', 'list_login_sessions', 'revoke_login_session', 'logout', 'logout_all', 'change_my_password', 'get_security_status', 'mfa_setup', 'mfa_enable', 'mfa_disable', 'verify_mfa', 'request_email_verification', 'admin_reset_mfa']);
const CLINICAL_TAGS = new Set(['Athlete health']);
const CLINICAL_PATH = /^\/(medical|appointments|followups|me\/(wellness|body-pain|loads|load-history|workload|readiness)|people\/:id\/clearance)/;

/** read | write | payment | clinical | admin. A capability may pin its own with `scope:`. */
export function classify(c) {
  if (c.scope) return c.scope;
  if (ACCOUNT.has(c.name) || c.path.startsWith('/admin') || (Array.isArray(c.auth) && c.auth.length === 1 && c.auth[0] === 'admin')) return 'admin';
  if (CLINICAL_TAGS.has(c.tag) || CLINICAL_PATH.test(c.path) || (c.tag === 'Health' && !c.path.startsWith('/providers'))) return 'clinical';
  if (PAYMENT.has(c.name)) return 'payment';
  return c.method === 'GET' ? 'read' : 'write';
}

const hasAny = (scopes, ...s) => scopes.includes(LEGACY_SCOPE) || s.some((x) => scopes.includes(x));

/** Does a token with these scopes allow a capability of this class? write implies read; the sensitive classes are never implied. */
export function scopeAllows(scopes, klass) {
  if (klass === 'read') return hasAny(scopes, 'read', 'write');
  return hasAny(scopes, klass);
}

// Which input fields name a restrictable resource.
const FIELD_TYPE = { venue_id: 'venue', team_id: 'team', event_id: 'event', organisation_id: 'organisation', org_id: 'organisation' };
const NOUN_TYPE = { venues: 'venue', teams: 'team', events: 'event', organisations: 'organisation' };

/** [{type,id}] references a request makes to restrictable resources. */
export function referencedResources(c, input) {
  const refs = [];
  for (const [k, t] of Object.entries(FIELD_TYPE)) if (typeof input?.[k] === 'string') refs.push({ type: t, id: input[k] });
  const noun = NOUN_TYPE[c.path.split('/')[1]];
  if (noun && c.path.includes(':id') && typeof input?.id === 'string') refs.push({ type: noun, id: input.id });
  return refs;
}

/** Scope check - runs before input parsing so a narrow token learns nothing about the shape of capabilities it may not use. */
export function enforceScope(credential, c) {
  if (!credential) return; // a signed-in session carries no extra limits
  const klass = c.scope ?? classify(c);
  if (!scopeAllows(credential.scopes, klass)) throw forbidden(`This API token does not have the "${klass}" scope needed for ${c.name}`);
}

/** Resource restriction - needs the parsed input. A restricted token may only call capabilities that name an allowed resource. */
export function enforceResources(credential, c, input) {
  if (!credential?.resources?.length) return;
  const refs = referencedResources(c, input);
  const ok = refs.length > 0 && refs.every((r) => credential.resources.some((a) => a.type === r.type && a.id === r.id));
  if (!ok) throw forbidden('This API token is restricted to specific venues, teams, events or organisations');
}
