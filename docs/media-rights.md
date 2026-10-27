# Sports Media, Broadcast & Rights (#482)

A rights-and-operations layer over canonical SportArena records. It is not a video platform or CDN. Where the event console is the one home for running an event, the **Broadcast** tab is where its media side lives; media partners and crew use one **Media & broadcast** workspace (More → Media & broadcast).

## Overlap / reuse matrix (latest `main` at the time of writing)

| Requested capability | Existing source | Verified gap | Smallest compatible extension |
|---|---|---|---|
| Competition, game, content scope | `events`, `fixtures` (no separate competition/season entity exists) | Rights package scope | `mr_packages` references `event_id` / `fixture_id`; collections are `mr_collections` |
| Media partner identity | `organisations`, `organisation_members` | "Can hold rights" marker | `media_partners` 1:1 with an organisation (same pattern as `governing_bodies`); no new org kind |
| Licence terms | `org_agreements` (executed legal text) | Operational rights projection | `mr_licences` points at `org_agreements` via `agreement_id`; legal text stays in Legal |
| Accreditation (#481) | Only `event_department_members.accreditation`; #481 is open and unmerged | Badge for crew | Crew reference the department member; badge is read live. Nothing duplicated; revisit when #481 lands |
| Files / media | `doc-store` (encrypted), `malware-scan` | Governed delivery | Photos/PDFs stored via `doc-store`, served only after live rights checks; video stays an external link (no transcoding/CDN is built) |
| Youth / personality safeguards | `youth_consents` purpose `media`, `hasConsent` | Per-asset subjects | `mr_asset_subjects`; consent re-read on every view |
| Streaming | nothing | Stream reference + honest state | `mr_streams`; provider is a reference only, state is reported by organiser/partner |
| Data feeds | `api_tokens` (scopes, expiry, resources), public live/results capabilities | Entitlement, metering, per-credential limits | `mr_feed_grants` + a real `api_tokens` row restricted to the event; the feed reads canonical scoring and results |
| Sponsor deliverables | `sponsorships` (target event) | Delivery tracking | `mr_deliverables` references the sponsorship; its status is read live; reach only from `mr_measurements` with a named source |
| Rights fees / invoices | `payments` (hosted checkout, refunds, settlement classes) | No rights-fee payable | `mr_fees` raised against a licence (never above the contracted fee, licence currency), paid via payments purpose `media_rights_fee` or recorded as received offline; revenue report shows contracted / invoiced / collected (online vs offline) / outstanding / overdue / refunded per currency |
| Notifications, audit | `notify`, `audit_log` | Append-only history | `mr_log` (trigger-protected) |

## Honest limits
- No native device run; web build verified at phone, tablet and desktop widths.
- Stream providers are references; no provider adapter is integrated, so state is never provider-verified.
- Fee numbers (`MRF-…`) are the rights-fee document; they are not rows in the venue/academy `invoices` table (no tax engine is applied to rights fees). Paying out the organiser's receivable is a settlement step outside this change, as for academy charges.
- #481 accreditation zones/QR do not exist yet; the badge is the event department's.
