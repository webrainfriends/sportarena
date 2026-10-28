# WhatsApp notifications

> Approved-template WhatsApp Business (official Cloud API), SMS, consent evidence, quotas and the Communication settings screens are in [communications.md](communications.md). This page covers the OpenWA free-text path, which stays as the fallback and for dedicated numbers.

WhatsApp is a third notification channel next to the in-app inbox, email and push. Messages are sent through a self-hosted
[OpenWA](https://github.com/rmyndharis/OpenWA) gateway. OpenWA is a standalone server (not a library), so the deploy runs it as a
Docker container (`sportarena-openwa`, bound to `127.0.0.1:2785`, persistent volume `sportarena_openwa_data`) and the API calls its REST API.

## How it works
- **Opt-in.** A person adds their number with the country code in *Notifications*, receives a 6-digit code on WhatsApp, enters it, and the
  channel switches on (`notification_prefs.whatsapp`). *Stop WhatsApp* opts out; the number stays on file (nothing is deleted).
- **Stored encrypted** (`whatsapp_contacts.phone_enc`, context `whatsapp_contacts.phone`); each send is audit-logged (`dispatch_whatsapp`).
- **Allow-list of kinds** (`ALLOWED` in `src/whatsapp.js`): bookings, waitlist offers, team and event messages, invitations. Security codes,
  health, insurance, legal and payout messages never go over WhatsApp, and a new notification kind is private until added to the list.
- **Adults only.** Under-18 accounts are never messaged directly.
- **Reliable and paced.** A WhatsApp message is a `notification_deliveries` row (`channel='whatsapp'`) with the same claim / backoff /
  dead-letter handling as email and push. The worker sends at most `WHATSAPP_PER_CYCLE` (20) per cycle with a jittered gap
  (`WHATSAPP_MIN_GAP_MS`), and each send carries an `Idempotency-Key`, so a retry never double-sends.

## Numbers
- **Platform number (default).** A platform admin adds it in *Admin > WhatsApp numbers* and scans the QR in WhatsApp > Linked devices.
- **Dedicated numbers.** An admin can grant a separate number to an event, organisation, sponsor, provider (physio, doctor, coach) or venue
  (`POST /admin/whatsapp/senders` with `scope_kind` + `scope_id`), as part of that owner's subscription. A notification uses it when the caller
  sets `data.sender_scope = { kind, id }`; otherwise, or after the number is revoked, the platform number is used. There is no subscription
  billing system yet, so the grant is an admin action; billing can attach to `whatsapp_senders` later.

## Configuration
| Variable | Meaning |
|---|---|
| `OPENWA_URL`, `OPENWA_API_KEY` | Written by the deploy (key read from the container's `/app/data/.api-key`). Unset = WhatsApp off, deliveries wait. |
| `OPENWA_DEFAULT_SESSION` | Optional OpenWA session id used when no platform number is linked in the app. |
| `WHATSAPP_PER_CYCLE`, `WHATSAPP_MIN_GAP_MS` | Pacing. |
| Repository variables `OPENWA_ENABLED` (`false` skips the container), `OPENWA_ENGINE` (`baileys` default, or `whatsapp-web.js`), `OPENWA_VERSION` (default `latest`; pin it) | Used by `deploy-remote.sh`. |

## Risks
OpenWA drives WhatsApp through reverse-engineered clients: the number can be restricted by Meta. Use a dedicated number you can afford to
lose, warm it up, keep email / push as the fallback, and keep consent explicit. OpenWA itself advises against relying on it for regulated
data or EU/EEA end-user messaging, which is why sensitive kinds are excluded. Meta's official WhatsApp Cloud API is the compliant option.
