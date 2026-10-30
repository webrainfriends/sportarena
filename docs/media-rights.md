# Sports Media, Broadcast & Rights (#482, #590)

A rights-and-operations layer over canonical SportArena records. It is not a video platform or CDN. Where the event console is the one home for running an event, the **Broadcast** tab is where its media side lives; media partners and crew use one **Media & broadcast** workspace (More → Media & broadcast).

## Overlap / reuse matrix (latest `main` at the time of writing)

| Requested capability | Existing source | Verified gap | Smallest compatible extension |
|---|---|---|---|
| Competition, game, content scope | `events`, `fixtures` (no separate competition/season entity exists) | Rights package scope | `mr_packages` references `event_id` / `fixture_id`; collections are `mr_collections` |
| Media partner identity | `organisations`, `organisation_members` | "Can hold rights" marker | `media_partners` 1:1 with an organisation (same pattern as `governing_bodies`); no new org kind |
| Licence terms | `org_agreements` (executed legal text) | Operational rights projection | `mr_licences` points at `org_agreements` via `agreement_id`; legal text stays in Legal |
| Accreditation (#481) | `accreditations`, zones and categories (merged) | Crew badge | Crew badge is the holder's real accreditation for the event, read live (issued / pending / suspended) with the zones the credential opens; the older department flag only speaks when the person has no accreditation. Nothing is copied |
| Files / media | `doc-store` (encrypted), `malware-scan` | Governed delivery | Photos/PDFs stored via `doc-store`, served only after live rights checks; video stays an external link (no transcoding/CDN is built) |
| Youth / personality safeguards | `youth_consents` purpose `media`, `hasConsent` | Per-asset subjects | `mr_asset_subjects`; consent re-read on every view |
| Streaming | nothing | Stream reference + honest state | `mr_streams`; provider is a reference only, state is reported by organiser/partner |
| Data feeds | `api_tokens` (scopes, expiry, resources), public live/results capabilities | Entitlement, metering, per-credential limits | `mr_feed_grants` + a real `api_tokens` row restricted to the event; the feed reads canonical scoring and results |
| Sponsor deliverables | `sponsorships` (target event) | Delivery tracking | `mr_deliverables` references the sponsorship; its status is read live; reach only from `mr_measurements` with a named source |
| Rights fees / invoices | `payments` (hosted checkout, refunds, settlement classes) | No rights-fee payable | `mr_fees` raised against a licence (never above the contracted fee, licence currency), paid via payments purpose `media_rights_fee` or recorded as received offline; revenue report shows contracted / invoiced / collected (online vs offline) / outstanding / overdue / refunded per currency |
| Notifications, audit | `notify`, `audit_log` | Append-only history | `mr_log` (trigger-protected) |
| Fan follows and feeds (#590) | `spectator_follows` (event / team / athlete / game) and the public event media list | Fan feed across everything followed; "new media" alert | `media` is one more alert on the existing follow; `GET /me/media-feed` uses the same visibility rule as the public event page (published, public, worldwide, live); followers are told once when an asset goes live (`mr_assets.followers_notified_at`), also after a scheduled time or embargo passes (sweep). Youth and private events never alert fans |
| Auditable rights check (#590) | `assetState`, `licenceCovers`, youth consent | One explainable answer before publish / export / hand-over | `check_media_rights` answers every rule (status, file, source, consent, expiry, embargo, schedule, audience, platform, territory, licence and delay) with provenance and writes `mr_rights_checks` (append-only). Publishing runs the same check (blocked attempts are recorded too); licensed downloads are logged as `download`; `list_rights_checks` is the organiser's trail |

## Honest limits
- No native device run; web build verified at phone, tablet and desktop widths.
- Stream providers are references; no provider adapter is integrated, so state is never provider-verified.
- Fee numbers (`MRF-…`) are the rights-fee document; they are not rows in the venue/academy `invoices` table (no tax engine is applied to rights fees). Paying out the organiser's receivable is a settlement step outside this change, as for academy charges.
- The rights check judges what the platform knows (licence, territory, platform, delay, consent). It cannot see where a recipient actually publishes a copy it has exported; the export is the recorded fact, the contract is the remedy.
- Fan media alerts follow public worldwide material only; territory-limited and licensed material never reaches the fan feed.
