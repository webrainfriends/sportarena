// Tests for CROSS-ROLE-02: Coach / Referee / Physio credential verification parity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../src/db.js';
import { RULES, EVIDENCE_KINDS, missingEvidence, badgesFor } from '../src/verification.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { checkRoleVerificationGate } from '../src/capabilities/credential-verification-enforcement.js';

const PHYSIO_REG_AAD = 'verification_cases.registration_no';

describe('credential verification parity', () => {
  it('referee type exists in RULES', () => {
    assert.ok(RULES.referee, 'RULES.referee must exist');
    assert.equal(RULES.referee.needs_role, 'referee');
    assert.equal(RULES.referee.validity_months, 24);
  });

  it('physio type exists in RULES with updated requirements', () => {
    assert.ok(RULES.physio, 'RULES.physio must exist');
    assert.ok(RULES.physio.one_of?.includes('physiotherapy_registration'), 'physio one_of must include physiotherapy_registration');
    assert.ok(RULES.physio.checklist.some((c) => c.key === 'professional_body_recorded'), 'physio checklist must include professional_body_recorded');
  });

  it('referee RULES includes grade_recorded checklist item', () => {
    assert.ok(RULES.referee.checklist.some((c) => c.key === 'grade_recorded'), 'referee checklist must include grade_recorded');
  });

  it('referee RULES includes referee_licence in one_of', () => {
    assert.ok(RULES.referee.one_of?.includes('referee_licence'), 'referee one_of must include referee_licence');
  });

  it('EVIDENCE_KINDS includes physiotherapy_registration and referee_licence', () => {
    assert.ok(EVIDENCE_KINDS.physiotherapy_registration, 'EVIDENCE_KINDS must include physiotherapy_registration');
    assert.ok(EVIDENCE_KINDS.referee_licence, 'EVIDENCE_KINDS must include referee_licence');
  });

  it('missingEvidence for physio with physiotherapy_registration satisfies requirement', () => {
    const missing = missingEvidence('physio', ['id_document', 'physiotherapy_registration']);
    assert.deepEqual(missing, [], 'physiotherapy_registration alone (+ id_document) should satisfy physio requirement');
  });

  it('missingEvidence for referee with referee_licence satisfies requirement', () => {
    const missing = missingEvidence('referee', ['id_document', 'referee_licence']);
    assert.deepEqual(missing, [], 'referee_licence should satisfy referee one_of requirement');
  });

  it('physio_registration_no encrypts and decrypts correctly', () => {
    const reg = 'PH-2024-123456';
    const enc = encrypt(reg, PHYSIO_REG_AAD);
    assert.ok(enc, 'encrypt must return a value');
    const dec = decrypt(enc, PHYSIO_REG_AAD);
    assert.equal(dec, reg, 'decrypted value must match original');
  });

  it('physio_registration_no cross-column misuse fails', () => {
    const reg = 'PH-2024-123456';
    const enc = encrypt(reg, PHYSIO_REG_AAD);
    assert.throws(
      () => decrypt(enc, 'verification_evidence.reference'),
      'decrypting with wrong AAD must throw',
    );
  });

  it('checkRoleVerificationGate returns allowed=true when no policy', async () => {
    const fakeDb = { query: async () => ({ rows: [] }) };
    const result = await checkRoleVerificationGate(fakeDb, { userId: 'fake', role: 'physio', ownerId: 'fake', ownerType: 'org' });
    assert.equal(result.allowed, true);
    assert.equal(result.policy_required, false);
  });

  it('checkRoleVerificationGate returns allowed=false when policy requires and no badge', async () => {
    let callCount = 0;
    const fakeDb = {
      query: async (sql) => {
        callCount++;
        if (callCount === 1) return { rows: [{ require_verified: true, grace_days: 0 }] };
        return { rows: [] };
      },
    };
    const result = await checkRoleVerificationGate(fakeDb, { userId: 'fake', role: 'coach', ownerId: 'fake', ownerType: 'org' });
    assert.equal(result.allowed, false);
    assert.equal(result.policy_required, true);
    assert.equal(result.verified, false);
  });
});
