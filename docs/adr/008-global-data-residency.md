# ADR 008 — Global Data Residency

**Date:** 2026-11-08  
**Status:** Accepted  
**Deciders:** Platform owners  
**Issue:** #961

## Context

GotMyGame operates a single AWS deployment in Singapore (`ap-southeast-1`). As the platform serves elite academies globally, users' verified home countries must determine where their personal data is stored. The business goal is compliance with country-level data-localisation laws without blocking platform growth.

## Decision

Implement a phased, country-aware data residency control plane:

- **Phase A (this PR):** A control-plane-only Global Residency/Placement Directory in the existing Singapore database. No per-region data-plane routing yet. Singapore is the only active region. Users in unsupported countries get an explicit Singapore fallback consent flow.
- **Phase B (issue #247 dependency):** Per-region API/worker deployments, private RDS, S3 buckets, IAM/KMS CMKs.
- **Phase C:** Federation of canonical records; one authoritative write per entity.
- **Phase D:** Operational maturity — policy-as-code, incident response, RPO/RTO documentation.

## Key design choices

1. **Country-at-registration, never from IP/GPS.** The user declares `home_country` at account creation; the system never silently re-homes based on login location.
2. **Consent before data.** No `residency_assignments` row is created until the user either (a) selects a country with an active in-country region, or (b) grants explicit Singapore fallback consent.
3. **Immutable consent records.** `residency_consents` rows are never deleted; revocation adds `revoked_at` only.
4. **Policy hash enforcement.** `grant_singapore_fallback_consent` checks `policy_text_hash` server-side — a stale client cannot bypass a policy update.
5. **13-stage migration state machine.** Preserves data in both regions until cutover is confirmed; rollback available until stage 9.
6. **Platform-admin gate.** `approve_region_activation`, `audit_residency_assignments`, and `export_region_compliance` are guarded by `mustBePlatformAdmin` (email allowlist check, not just role label).

## Consequences

- Adds 5 tables and 1 column to the existing schema (all additive).
- Introduces 12 new MCP/REST/OpenAPI capabilities under the `Data Residency` tag.
- Singapore remains the sole active region until Phase B infrastructure is provisioned and activated via `approve_region_activation`.
- Sri Lankan and other unsupported-country users must explicitly consent to Singapore storage before personal data is written.
