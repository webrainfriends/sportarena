# India omnichannel communications (WhatsApp Business, SMS)

One delivery layer for in-app, push, email, **WhatsApp Business** and **SMS**. Every module (academy fees, teams, venues, events, coaches, sponsors, tenders)
keeps calling `notify()`; this layer decides, from the same stored notification, whether it also leaves as an approved template. There is no
module-specific messaging code and no second queue. Issue #499.

## Reuse map (notification use case → source → delivery path → gap → extension)

| Use case | Existing event / source | Path before | Gap | Extension |
|---|---|---|---|---|
| Academy fee due / overdue | `collections_reminder` (`collections.js`) | in-app, email, push, OpenWA free text | no SMS, no approved template, no receipts | caller sets `comm.use_case` (`fee_due` / `fee_overdue`); amount and due date are read from `academy_charges` |
| Payment failed / receipt | `collections_retry`, `academy_payment_received` / `_part` | same | same | mapped in the catalogue (`payment_retry`, `fee_receipt`) |
| Trial booking, session reminder | `trial_booking`, `booking_reminder` | same | same | mapped |
| Match / tournament selection and reminder | `team_selection`, `team_attendance_request` | same | same | mapped |
| Venue booking / change / cancellation | `reservation_confirmed`, `booking_modified`, `booking_cancelled` | same | venue-initiated changes are operational | `comm.essential` set where the venue changes or cancels |
| Event registration, announcements | `event_invitation`, `event_waitlist`, `event_announcement`, `event_schedule` | same | urgent notices | urgent announcements use `emergency_announcement` (essential) |
| Emergency / venue-change | `event_cancelled`, `event_paused`, `event_resumed` | same | | essential |
| Tender deadlines, coach booking, sponsor milestones | `tender_deadline`, `coach_response_accepted`, `sponsorship_update` / `_award` / `_offer` | same | | mapped (link-only variables) |
| Event payment reminder | no producer yet | | | use case and template slot exist; **no producer wired (gap)** |
| Account / security | `security_*` | email / in-app | one-time secrets must not ride on WhatsApp or SMS | **deliberately not mapped** |

## How a message flows

1. `notify()` stores the notification (idempotent per recipient via `dedupe_key`) and the usual in-app / email / push rows, then calls `planComms()` inside its own savepoint. A fault there is logged and costs the caller nothing.
2. `planComms()` maps the kind to a **use case** (`src/comms-catalogue.js`). Unmapped kinds never leave as WhatsApp/SMS (private by default).
3. The notification is attributed to its organisation (named on it, else the owner of its event or team); that decides the provider account, the quota and whose activity list shows it. For WhatsApp, then SMS, a delivery is queued only if: a provider account is in force (organisation's own, else the platform's); the recipient is an adult with a verified number, not opted out, channel switched on, number not suppressed, category not switched off (unless essential); an active template exists (recipient language → English); every variable resolves from system data; the organisation is within its quota (essential messages ignore it up to twice the allowance, so an "urgent" flag cannot spend without bound); booking messages go only to the person the booking belongs to (venue staff get the notification, never a customer-style text). One primary channel is queued; the template's `fallback_channel` is tried once if the primary fails permanently or runs out of attempts.
4. `dispatchComms()` (worker cycle) claims due rows (`FOR UPDATE SKIP LOCKED` + lease, refreshed row by row so a slow batch is never re-claimed), **re-checks consent right before the provider call**, sends through the adapter, and records `sent` + the provider reference. Failures back off exponentially, dead-letter after 5 attempts (visible under admin jobs, requeueable) and never touch the business transaction.
5. The provider's signed webhook moves the row `sent → delivered → read`, or `failed`; STOP replies and provider "user opted out" errors become opt-outs.

When a templated WhatsApp message is queued, the legacy free-text OpenWA copy is skipped, so nobody receives the same message twice.

## Delivery states (what the UI may say)

`queued` (stored, not handed to the provider) → `sent` (accepted by the provider, no receipt) → `delivered` → `read`; or `failed` (with provider code) or `suppressed` (with the reason: opted out, quota, no template, missing data…). "Delivered" is only ever shown after a provider receipt. Receipts never move a message backwards.

## Templates

Per organisation or platform: use case, channel, language, **provider template id / version**, typed variables, fallback channel, state `draft → pending → active → retired`. A change is a new version; older versions are retired, never edited or deleted. Activation (recording the provider's approval) is a platform-admin action.

Variables are typed and resolved by the server: `name`, `label` (short organisation / venue / team / event names), `currency` (minor units + code), `date`, `datetime` (Asia/Kolkata), `link` (always the server's authorised in-app deep link). **There is no free-text type**, a template can declare only the variables its use case offers, and neither the message body nor a name/label value can carry a web address (an event named "Win now bit.ly/x" is held, with the reason shown, never sent). Variables are stored encrypted (`vars_enc`). Notes, health, bank, pricing and legal fields cannot be bound to any variable. Booking details are only described to the person the booking belongs to (venue staff get the same notification but no customer-style message).

## Consent and opt-out

* `comm_consents` is an append-only log: channel, opt-in/out, source (`app_verification`, `app_switch`, `inbound_stop`, `provider_suppression`, `admin`), basis, time. People can read their own (`GET /me/communication-consents`).
* Numbers are verified by a code sent to them (WhatsApp via OpenWA or the Cloud API; SMS via the gateway), at most 5 codes a day and one a minute (SMS-pumping guard). Adults only: under-18 accounts are never messaged; a guardian is messaged as themselves on their own number.
* Verification codes: a number a provider reported invalid or blocked is never texted, and no number receives more than 3 codes in 24 hours across all accounts.
* **STOP**, removing the number in the app, and provider suppression take effect immediately: the flag, the preference switch and the consent row are written together, queued messages are withdrawn, and the number is suppressed platform-wide (`comm_suppressions`). The dispatcher re-checks before every send. Essential messages ignore category switches and quotas, **never** an opt-out or a number-level suppression. Verifying the number again is a new opt-in and lifts a STOP suppression.
* Security alerts and codes stay on email / in-app.

## Providers

| Kind | Channel | Notes |
|---|---|---|
| `whatsapp_cloud` | WhatsApp | Official Business Cloud API, template messages. Webhook: `GET/POST /api/v1/webhooks/comms/whatsapp_cloud/:providerId`, verified with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) and the verify-token handshake. |
| `sms_http` | SMS | An HTTPS gateway bridge in front of MSG91 / Twilio / Kaleyra etc. `POST {url}` `{ to, sender, text, template_id, entity_id, reference }` with `Idempotency-Key` → `{ id }`. Webhook: `POST /api/v1/webhooks/comms/sms_http/:providerId` `{ events: [...] }` signed with `X-Signature` (hex HMAC-SHA256). `template_id` carries the DLT template, `entity_id` the DLT principal entity. |
| OpenWA | WhatsApp | Unchanged (free text, allow-listed kinds). Kept as the fallback path and for dedicated numbers. |

Credentials live encrypted in `comm_providers.config_enc` (context `comm_providers.config`), are write-only through the API, and a rotation closes the old row (`effective_to`) and opens a new one. Linking, retiring and quota changes are audit-logged. Receipts are matched to the provider account that sent the message (`provider_account_id`), and a retired account's webhook secret stops being accepted after 14 days. Provider error text is stored with phone numbers removed. The Cloud API base can be overridden with `WHATSAPP_CLOUD_BASE`; `COMMS_PER_CYCLE` (default 50) bounds a worker cycle.

A real provider needs an account, an approved template per use case, and (India) DLT registration. Those are outside the code and are the explicit blockers below.

## Quotas and usage

`comm_quotas` holds an effective-dated monthly allowance per channel for the platform default or one organisation (`monthly_limit` NULL = unlimited, optional `addon_key` for a paid add-on; no price is fixed anywhere). Usage is **counted from `notification_deliveries`** (queued/sent/delivered/read in the current Asia/Kolkata month), so there is no second counter to drift. At the limit a non-essential message is recorded as `suppressed: quota_exceeded` and the in-app / email / push copies still go.

## API, OpenAPI and MCP

All capabilities are in `src/capabilities/communications.js` (REST + OpenAPI + MCP from one definition): `get_communication_catalogue`, `get_communication_settings`, `list_comm_templates`, `create_comm_template`, `set_comm_template_state`, `preview_comm_template`, `list_comm_deliveries`, `retry_comm_delivery`, `get_comm_usage`, `link_comm_provider`, `retire_comm_provider`, `set_comm_quota` (platform admin, `mustBePlatformAdmin`), `get_sms_status`, `request_sms_verification`, `confirm_sms_verification`, `remove_sms_number`, `list_my_communication_consents`. Preferences extend the existing `get/update_notification_preferences` (adds `sms`, `comm_categories_off`, `comm_locale`). Organisation capabilities require an active owner / admin / finance membership (404 for outsiders). The activity list never returns phone numbers or message variables. Provider webhooks are plain signature-gated routes, deliberately not tools.

## App

* Organisation → **Communication** tab (owner / admin / finance): Channels, Templates, Activity, Usage. A tab strip on phones, a side rail from tablet width; the same React Native screen on iOS, iPadOS, Android and web.
* Platform console → **Communications** (replaces the old WhatsApp numbers tab; the numbers screen lives inside it): provider accounts, allowances, WhatsApp numbers, platform templates, usage.
* Notifications screen: WhatsApp and SMS number cards (one shared `NumberCard`), message categories, language, and the consent on record.

## Requirement → evidence (issue #499)

| Acceptance criterion | Evidence |
|---|---|
| One event fans out without duplicate business logic | `test/communications.test.js` "academy fee reminder…": a real `runCollections` sweep produces exactly one templated delivery; no module contains messaging code |
| Provider failures do not roll back the business transaction | "a provider outage or a planning fault…" (provider down, planning fault, dead-letter + retry) |
| Template variables schema-validated, no sensitive text | "templates are strictly typed…", "only mapped business kinds…" |
| Opt-out / revocation immediate | "STOP by SMS reply…", "removing the number in the app…", "a provider 'user opted out' failure…" |
| Fee / booking / urgent messages idempotent | fee test (second sweep, double dispatch → one provider call); unique `(notification_id, channel)` index; delivery id as `Idempotency-Key` |
| Webhooks verified and replay-safe | "delivery receipts are signed, replay-safe…" (bad/no signature 401, replay, out-of-order, unmatched, handshake) |
| Honest delivery state | same test: `sent` until the receipt; `delivered`/`read` never regress |
| Academy, team, venue, event, coach use the same service | fee journey (academy), "venue booking journey", "team, event and sponsor use cases…", emergency announcement (event) |
| Usage / quota metrics | "quotas…" |
| REST/OpenAPI/MCP cannot bypass privacy rules | "every communications capability is on REST, OpenAPI and MCP…"; org scoping and 404s in the receipts test |

Residual risks, stated plainly: the opt-out check happens immediately before the provider call, so a STOP that arrives during that single HTTP call cannot recall a message already in flight; a worker crash between the provider accepting a WhatsApp Cloud message and the bookkeeping update can re-send it once (the Cloud API has no idempotency key; the SMS bridge does); the SMS gateway URL is set by the platform admin only and is not network-restricted beyond https in production.

Not verifiable without external accounts (explicit blockers): live WhatsApp Business and SMS provider credentials, Meta template approval, India DLT registration, delivery over real handsets, and native-device runs of the app (only the web, iOS and Android bundles are compiled here).
