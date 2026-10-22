# Sponsor identities (#282)

Individual, company and organization sponsors with a legal and billing identity, authorised representatives, several
entities per person, portfolios of brands, and a frozen identity per agreement version. Everything extends the existing
`sponsors` / `sponsorships` tables and the shared `cap(...)` registry (REST + OpenAPI + MCP); there is no second sponsor
system, ledger or verification process.

## Model
* `sponsor_entities` — the legal/billing identity: `sponsor_type` (`individual|company|organization`), `legal_name`,
  `registration_country` (ISO alpha-2), encrypted `registration_number_enc`, `tax_id_enc`, `billing_email_enc`,
  `billing_address_enc`, optional `organisation_id` (an existing organisation, organization sponsors only), `row_version`.
* `sponsors` (the **brand**, public display name) gets nullable `entity_id` and `archived_at`. One entity owns many
  brands; one person can run several entities.
* `sponsor_representatives` — per entity: `owner` (several allowed) · `admin` · `finance` · `portfolio_manager` · `viewer`;
  status `invited → active → left` (or `declined`). Nobody is deleted; leaving sets `left_at`.
* `sponsor_portfolios`, `sponsor_portfolio_brands`, `sponsor_portfolio_assignments` — owner/admin groups brands and
  assigns portfolio managers; removal sets `removed_at` / `ended_at`.
* `sponsorship_identity_snapshots` — per `(sponsorship, version)`: display name, legal name, type and who proposed, written
  when the version is proposed or revised (first write wins). Registration/tax/billing are never copied.

## Permissions (server side, read live on every call — `src/sponsor-access.js`)
| Role | read | make/revise/withdraw offers, objectives, reviews | payments, goods, endorsements | identity, team, portfolios, verification |
|---|---|---|---|---|
| owner / admin | ✓ | ✓ | ✓ | ✓ (only owners appoint or change owners and admins) |
| finance | ✓ | – | ✓ | – |
| portfolio_manager | only brands in an assigned portfolio | ✓ (same brands) | ✓ (same brands) | – |
| viewer | ✓ | – | – | – |

A brand **without** an entity (every pre-existing brand) is controlled by its `owner_id` alone, exactly as before. Once a
brand belongs to an entity only active representatives (and platform admins) have access, so removing someone ends their
access immediately. The entity always keeps at least one active owner. Outsiders get 404, not 403, so existence is not leaked.

## API
`get_sponsor_identity`, `set_sponsor_identity` (needs `row_version`; stale → 409 with the current version),
`attach_sponsor_brand`, `list_my_sponsor_identities` (entities, invitations, brands still without identity),
`list/invite/respond/update/remove_sponsor_representative(s)`, `create/list/update_sponsor_portfolio`,
`export_sponsor_identity` (owner/admin, audit `export_pii`). `create_sponsor` accepts `sponsor_type`/`legal_name` (new
entity you own) or `entity_id` (another brand under an entity you own or administer). Decrypting registration/tax/billing is
audit-logged (`read_pii`). `get_sponsorship` returns `sponsor_identity` (the frozen snapshot). The verification reviewer
view (`get_verification`) shows the declared legal name, type and country for the checklist item "registered name matches";
verification is requested by owner/admin representatives and still uses the existing sponsor rules.

## Privacy
`list_sponsors` / `get_sponsor` return only display name, industry, website, emoji, `sponsor_type` and the verified badge.
Legal name, registration, tax, billing and the team are never public, even when verified. Representatives must be adult
accounts. Nothing here infers consent, payment settlement or delivery.

## States in the app (More → Sponsors → My brands → Identity)
Loading, empty (no brands / only you / no portfolios), denied or not-visible (404/403 explained, no retry), recoverable
error with Retry, stale version (latest loaded behind the open form, edits kept, "review and save again"), read-only view
for roles that cannot edit. Country uses a search control, type chips, portfolios multi-select, people a search-and-pick.

## Migration, rollback, recovery
`087_sponsor_identities.sql` is additive: new tables and two nullable/defaulted columns on `sponsors`. Existing brands stay
`identity not confirmed` with no invented data; one snapshot per existing agreement version records only the brand name and
proposer. Rollback = deploy the previous code (new tables/columns are ignored). Recovery = nothing is deleted: re-invite a
person who left, restore an archived portfolio (`archived:false`).

## Dependency order and boundaries
Builds on organisations (022), verification (015), agreements (#145, 042), performance (075). Later work that should reuse it:
opportunities/applications (#67), passport/evidence (#64), shared settlement (#71), email/notifications (#243), branded
documents (#249). Known limits: a brand's verification badge belongs to the brand (not inherited by sibling brands);
invitations are in-app notifications only (email depends on #243); changing the legal name after verification does not
automatically re-open the verification case.
