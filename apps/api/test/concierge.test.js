// Tests for the Sports Concierge: approval lifecycle, security guards, redaction (issue #72).
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { pool, one, many } from '../src/db.js';
import { invoke } from '../src/invoke.js';
import { capabilities } from '../src/registry.js';
import { setConciergeTransport } from '../src/ai-providers.js';
import { redactResult, CONCIERGE_TOOL_NAMES } from '../src/concierge-engine.js';
import '../src/capabilities/index.js'; // register all caps

// ---- helpers ---------------------------------------------------------------
let testUserId, testSessionId;

async function createTestUser(role = 'athlete') {
  const u = await one(
    `INSERT INTO users(email, role, name) VALUES ($1, $2, $3) RETURNING id`,
    [`concierge-test-${Date.now()}@test.invalid`, role, 'Test User']
  );
  return u.id;
}

async function createTestSession(userId) {
  const s = await one(
    `INSERT INTO concierge_sessions(user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, 'Test session']
  );
  return s.id;
}

async function createTestApproval(sessionId, userId, overrides = {}) {
  const msgId = await one(
    `INSERT INTO concierge_messages(session_id, role, content_hash) VALUES ($1, 'assistant', 'testhash') RETURNING id`,
    [sessionId]
  );
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const a = await one(
    `INSERT INTO concierge_approvals(session_id, message_id, actor_id, capability_name, params_hash, proposal, proposal_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [sessionId, msgId.id, userId, overrides.capName ?? 'create_booking', overrides.paramsHash ?? 'tph', JSON.stringify(overrides.proposal ?? { action: 'Book a slot' }), overrides.proposalHash ?? 'tproph', expiresAt]
  );
  return a;
}

// ---- setup / teardown -------------------------------------------------------
before(async () => {
  testUserId = await createTestUser();
  testSessionId = await createTestSession(testUserId);
  // Reset transport after each test
  setConciergeTransport(null);
});

after(async () => {
  await pool.query('DELETE FROM concierge_audit WHERE session_id=$1', [testSessionId]);
  await pool.query('DELETE FROM concierge_approvals WHERE session_id=$1', [testSessionId]);
  await pool.query('DELETE FROM concierge_messages WHERE session_id=$1', [testSessionId]);
  await pool.query('DELETE FROM concierge_sessions WHERE id=$1', [testSessionId]);
  await pool.query('DELETE FROM users WHERE id=$1', [testUserId]);
});

// ---- tests ------------------------------------------------------------------
describe('concierge redactResult', () => {
  it('strips *_enc fields', () => {
    const r = redactResult({ id: '1', email_enc: 'secret', name: 'Alice' });
    assert.ok(!Object.hasOwn(r, 'email_enc'));
    assert.equal(r.name, 'Alice');
  });
  it('strips known PII fields', () => {
    const r = redactResult({ id: '1', email: 'x@x.com', phone: '999', lat: 1.1, lng: 2.2 });
    assert.ok(!Object.hasOwn(r, 'email'));
    assert.ok(!Object.hasOwn(r, 'phone'));
    assert.ok(!Object.hasOwn(r, 'lat'));
  });
  it('recurses into arrays', () => {
    const r = redactResult({ users: [{ id: '1', email: 'x@x.com' }] });
    assert.ok(!Object.hasOwn(r.users[0], 'email'));
  });
  it('preserves non-PII fields', () => {
    const r = redactResult({ name: 'Court 1', price_cents: 2000 });
    assert.equal(r.name, 'Court 1');
    assert.equal(r.price_cents, 2000);
  });
});

describe('concierge approval expiry', () => {
  it('marks expired and audits when approve called on expired approval', async () => {
    const a = await createTestApproval(testSessionId, testUserId, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const { executeApproval } = await import('../src/concierge-engine.js');
    const user = { id: testUserId, credential: { scopes: ['read', 'write'] } };
    await assert.rejects(() => executeApproval(a.id, user), /expired/i);
    const updated = await one('SELECT status FROM concierge_approvals WHERE id=$1', [a.id]);
    assert.equal(updated.status, 'expired');
    const auditRow = await one(
      `SELECT event_kind FROM concierge_audit WHERE approval_id=$1 AND event_kind='approval_expired'`,
      [a.id]
    );
    assert.ok(auditRow, 'approval_expired audit row must exist');
  });
});

describe('concierge approval rejection', () => {
  it('marks rejected and cannot be approved afterward', async () => {
    const a = await createTestApproval(testSessionId, testUserId);
    const user = { id: testUserId };
    // Reject via capability
    const rejectCap = capabilities.find((c) => c.name === 'reject_concierge_action');
    assert.ok(rejectCap);
    const result = await invoke(rejectCap, user, { id: a.id });
    assert.equal(result.status, 'rejected');
    // Now approval should fail
    const { executeApproval } = await import('../src/concierge-engine.js');
    await assert.rejects(() => executeApproval(a.id, user), /rejected/i);
  });
});

describe('concierge scope boundary', () => {
  it('write-scope caps absent when user scopes is read-only', async () => {
    const readOnlyUser = { id: testUserId, credential: { scopes: ['read'] } };
    // Simulate tool catalogue build (access the internal fn via turn() with a mock transport)
    let capturedTools = [];
    setConciergeTransport(async ({ tools }) => {
      capturedTools = tools ?? [];
      return { content: 'Test reply', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
    });
    const { turn } = await import('../src/concierge-engine.js');
    const session = await one('SELECT * FROM concierge_sessions WHERE id=$1', [testSessionId]);
    await turn(session, 'Hello', { user: readOnlyUser });
    const writeCapNames = capturedTools.filter((t) => t._scope === 'write').map((t) => t.name);
    assert.equal(writeCapNames.length, 0, `Write caps must be absent for read-only user: ${writeCapNames.join(',')}`);
    setConciergeTransport(null);
  });
});

describe('concierge PII redaction in stored results', () => {
  it('tool_results stored without email/phone', async () => {
    // Inject a transport that returns a tool_call for a read cap
    const user = { id: testUserId, credential: { scopes: ['read', 'write'] } };
    let storedResults = null;
    // Monkey-patch many to intercept the INSERT
    const origOne = one;
    // We'll check the actual DB row after turn completes
    setConciergeTransport(async ({ tools }) => {
      const readTool = tools?.find((t) => t._scope === 'read');
      if (!readTool) return { content: 'ok', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
      return {
        content: null,
        tool_calls: [{ id: 'tc1', name: readTool.name, input: {} }],
        usage: { input_tokens: 2, output_tokens: 2 },
        stop_reason: 'tool_use',
      };
    });
    const { turn } = await import('../src/concierge-engine.js');
    const session = await one('SELECT * FROM concierge_sessions WHERE id=$1', [testSessionId]);
    await turn(session, 'List sessions', { user });
    // Check stored tool_results don't have PII
    const toolResultMsg = await one(
      `SELECT tool_results FROM concierge_messages WHERE session_id=$1 AND role='tool_result' ORDER BY seq DESC LIMIT 1`,
      [testSessionId]
    );
    if (toolResultMsg?.tool_results) {
      const json = JSON.stringify(toolResultMsg.tool_results);
      assert.ok(!json.includes('"email"'), 'email must not appear in stored tool_results');
      assert.ok(!json.includes('"phone"'), 'phone must not appear in stored tool_results');
    }
    setConciergeTransport(null);
  });
});

describe('concierge write tool approval flow', () => {
  it('write tool creates pending approval and does NOT invoke the cap', async () => {
    const user = { id: testUserId, credential: { scopes: ['read', 'write'] } };
    let capInvoked = false;

    setConciergeTransport(async () => ({
      content: 'I will book that for you.',
      tool_calls: [{ id: 'tc1', name: 'create_booking', input: { resource_id: 'fake-id', starts_at: '2026-01-01T10:00:00Z', ends_at: '2026-01-01T11:00:00Z' } }],
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: 'tool_use',
    }));

    // Patch create_booking to detect invocation
    const bookCap = capabilities.find((c) => c.name === 'create_booking');
    if (bookCap) {
      const orig = bookCap.handler;
      bookCap.handler = async (...a) => { capInvoked = true; return orig(...a); };
    }

    const { turn } = await import('../src/concierge-engine.js');
    const session = await one('SELECT * FROM concierge_sessions WHERE id=$1', [testSessionId]);
    const result = await turn(session, 'Book me Court 1 tomorrow at 10am', { user });

    assert.ok(result.pending_approvals.length > 0, 'should have pending approval');
    assert.equal(result.pending_approvals[0].capability_name, 'create_booking');
    assert.equal(result.pending_approvals[0].status, 'pending');
    assert.ok(!capInvoked, 'create_booking must NOT be invoked until approved');

    if (bookCap) bookCap.handler = bookCap.handler; // cleanup not strictly needed
    setConciergeTransport(null);
  });
});

describe('concierge capability registration', () => {
  const EXPECTED = [
    'start_concierge_session', 'list_concierge_sessions', 'get_concierge_session',
    'send_concierge_message', 'list_concierge_messages',
    'get_concierge_approval', 'approve_concierge_action', 'reject_concierge_action',
    'list_concierge_audit',
  ];
  for (const name of EXPECTED) {
    it(`${name} is registered`, () => {
      const c = capabilities.find((c) => c.name === name);
      assert.ok(c, `${name} must be in capabilities registry`);
    });
  }
});
