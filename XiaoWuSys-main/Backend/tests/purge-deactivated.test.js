// Who takes over from a deactivated account (npm run purge:deactivated): same role where possible,
// otherwise a manager, never another deactivated account.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planReplacements } = require('../scripts/accounts/purge');

const active = [
  { user_id: 'o1', role: 'Owner' }, { user_id: 'a1', role: 'Admin' }, { user_id: 'a2', role: 'Admin' }, { user_id: 's1', role: 'Staff' }
];

describe('Deactivated accounts: who takes over', () => {
  it('prefers active accounts with the same role', () => {
    const [p] = planReplacements([{ user_id: 'x', username: 'x', role: 'Staff' }], active);
    assert.deepEqual(p, { old_id: 'x', username: 'x', from_role: 'Staff', role: 'Staff', candidates: ['s1'] });
    assert.deepEqual(planReplacements([{ user_id: 'y', role: 'Admin' }], active)[0].candidates, ['a1', 'a2']);
  });

  it('falls back to a manager when no active account has the role', () => {
    const p = planReplacements([{ user_id: 'z', role: 'Production' }], active)[0];
    assert.equal(p.role, 'Admin');
    assert.deepEqual(p.candidates, ['a1', 'a2']);
    assert.equal(planReplacements([{ user_id: 'w', role: 'Admin' }], [{ user_id: 'o1', role: 'Owner' }])[0].role, 'Owner');
  });

  it('every candidate is one of the active accounts and has the chosen role', () => {
    for (const role of ['Owner', 'Admin', 'Staff', 'Production']) {
      const p = planReplacements([{ user_id: 'q', role }], active)[0];
      assert.ok(p.candidates.length > 0);
      for (const id of p.candidates) assert.equal(active.find((a) => a.user_id === id).role, p.role);
    }
  });

  it('refuses when there is no active account at all', () => {
    assert.throws(() => planReplacements([{ user_id: 'q', role: 'Staff' }], []), /no active account/);
  });
});
