# Sponsoring an individual (SPOR-30)

No individual-specific subsystem: athletes are just another `target_type` of the existing `sponsorships` table
(`event`, `team`, `athlete`). This change adds the opt-in, the proposal details and the decision trail.

## Opt-in and privacy
* `sponsorship_profiles` (one row per user, **off by default**): `open_to_sponsors`, a public `pitch`, `looking_for`
  tags and `verified_sponsors_only`. Only athletes can turn it on (`set_sponsorship_profile`,
  `get_my_sponsorship_profile`); turning it off hides the person immediately and blocks new offers.
* `discover_sponsorable_athletes` (sponsors only) lists opted-in athletes with public profile fields (handle, display
  name, avatar, sports, pitch, tags, verified badges). Contact details, date of birth and other private data are never
  returned. Filters: text, sport, what they are looking for, verified.
* A deal aimed at a person is private on the sponsor's public page unless the athlete chooses
  `show_publicly` when accepting. Objectives, deliverables and messages are never public. Existing athlete deals were
  made private by the migration (nothing deleted).

## Proposal (`propose_sponsorship`, `target_type=athlete`)
* Money and/or in-kind support, a period (`starts_on` ≤ `ends_on`), **objectives**, **deliverables** (required) and an
  optional message. The athlete must be opted in, the sponsor brand must be owned by the caller and verified if the
  athlete asked for that.
* One open offer per sponsor and athlete; after a decline the same sponsor can offer again after 30 days.
* The athlete is notified (generic text); only they, or an admin, can accept or decline, with an optional reason.
  The sponsor can `withdraw_sponsorship` while the offer is unanswered; either side can end an active deal.
* `decided_at`, `decided_by` and `decision_reason` are kept; statuses: `proposed`, `active`, `declined`, `ended`,
  `withdrawn`.

## App
Ecosystem → Sponsors: athletes get an "Open to sponsors" switch and pitch editor; sponsors search opted-in athletes and
send an offer; both sides see every deal with its terms, status and reply, and can accept, decline, withdraw or end.
The Billboard inbox shows the same terms.
