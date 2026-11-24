// ==========================================
// DELETE THE DEACTIVATED ACCOUNTS (used by scripts/purgeDeactivatedUsers.js and its tests)
//
// "Deactivated" = users.is_active = FALSE (removed accounts are deactivated too).
// Every place that names a deactivated account is first handed to an ACTIVE account:
//   * every text column of the public tables called user_id or ending in _by (created_by,
//     received_by, performed_by, ...), plus any column with a foreign key to users;
//   * the matching role column (performed_role next to performed_by, ...) is set to the role of
//     the account that takes over, so name and role always agree;
//   * user ids written inside the audit trail's JSON details.
// Each row gets one of the active accounts at random, preferring the same role. When no active
// account has that role, the closest one does it: a manager (Admin, then Owner) can do every job.
// The audit entries ABOUT a deleted account (entity 'users') go with it, and so do its signed-out
// sessions. Then the accounts are deleted.
//
// ONE transaction: if anything fails, the database is left exactly as it was. The append-only
// trails (audit log, status history, stock card, consumables log) refuse UPDATE through their
// triggers, so the user triggers of each changed table are paused for the change and switched
// back on before COMMIT. Foreign keys and checks still apply.
// ==========================================
const ROLE_FALLBACK = {
  Owner: ['Owner', 'Admin'],
  Admin: ['Admin', 'Owner'],
  Staff: ['Staff', 'Admin', 'Owner', 'Production'],
  Production: ['Production', 'Admin', 'Owner', 'Staff']
};
const SKIP_TABLES = ['revoked_sessions', 'schema_migrations']; // sessions of a deleted account are deleted with it
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected name: ${name}`);
  return `"${name}"`;
};

// Who takes over from each deactivated account -> [{ old_id, role, candidates: [user_id] }]
const planReplacements = (inactive, active) => inactive.map((u) => {
  const order = ROLE_FALLBACK[u.role] || ['Admin', 'Owner', 'Staff', 'Production'];
  const role = order.find((r) => active.some((a) => a.role === r));
  if (!role) throw new Error('There is no active account to hand the records to. Activate one first.');
  return { old_id: u.user_id, username: u.username, from_role: u.role, role, candidates: active.filter((a) => a.role === role).map((a) => a.user_id) };
});

// The columns that hold a user id -> [{ table, column, roleColumn|null }]
const findUserColumns = async (db) => {
  const { rows } = await db.query(`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type IN ('character varying', 'text')
       AND (c.column_name = 'user_id' OR c.column_name LIKE '%\\_by')
    UNION
    SELECT cl.relname, a.attname
      FROM pg_constraint k
      JOIN pg_class cl ON cl.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
     WHERE k.contype = 'f' AND k.confrelid = 'public.users'::regclass
     ORDER BY 1, 2`);
  const all = (await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`)).rows;
  const has = (table, column) => all.some((r) => r.table_name === table && r.column_name === column);
  return rows
    .filter((r) => !SKIP_TABLES.includes(r.table_name) && !(r.table_name === 'users' && r.column_name === 'user_id'))
    .map((r) => {
      const roleColumn = r.column_name.endsWith('_by') ? `${r.column_name.slice(0, -3)}_role` : null;
      return { table: r.table_name, column: r.column_name, roleColumn: roleColumn && has(r.table_name, roleColumn) ? roleColumn : null };
    });
};

const loadAccounts = async (db) => {
  const { rows } = await db.query('SELECT user_id, username, role, is_active FROM users ORDER BY role, username');
  return { active: rows.filter((u) => u.is_active), inactive: rows.filter((u) => !u.is_active) };
};

// What would change -> { active, inactive, plan, references: [{ table, column, rows }], auditAbout, sessions }
const describePurge = async (db) => {
  const { active, inactive } = await loadAccounts(db);
  const ids = inactive.map((u) => u.user_id);
  const references = [];
  if (ids.length) {
    for (const c of await findUserColumns(db)) {
      const n = (await db.query(`SELECT COUNT(*)::int AS n FROM ${ident(c.table)} WHERE ${ident(c.column)} = ANY ($1)`, [ids])).rows[0].n;
      if (n) references.push({ ...c, rows: n });
    }
  }
  const count = async (sql) => (ids.length ? (await db.query(sql, [ids])).rows[0].n : 0);
  return {
    active,
    inactive,
    plan: ids.length && active.length ? planReplacements(inactive, active) : [],
    references,
    auditAbout: await count("SELECT COUNT(*)::int AS n FROM audit_log WHERE entity = 'users' AND entity_id = ANY ($1)"),
    sessions: await count('SELECT COUNT(*)::int AS n FROM revoked_sessions WHERE user_id = ANY ($1)')
  };
};

const purgeDeactivated = async (pool, { log = () => {} } = {}) => {
  const client = await pool.connect();
  const paused = [];
  try {
    await client.query('BEGIN');
    const { active, inactive } = await loadAccounts(client);
    if (inactive.length === 0) {
      await client.query('ROLLBACK');
      return { deleted: 0, updated: 0 };
    }
    const plan = planReplacements(inactive, active);
    const ids = plan.map((p) => p.old_id);

    await client.query('CREATE TEMP TABLE purge_map (old_id VARCHAR PRIMARY KEY, new_role VARCHAR NOT NULL, cands VARCHAR[] NOT NULL) ON COMMIT DROP');
    for (const p of plan) await client.query('INSERT INTO purge_map VALUES ($1, $2, $3)', [p.old_id, p.role, p.candidates]);

    const columns = await findUserColumns(client);
    const hasCol = async (table, column) => (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column])).rowCount > 0;
    const pause = async (table) => {
      if (paused.includes(table)) return;
      await client.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER USER`);
      paused.push(table);
    };

    // 1. The audit entries about the deleted accounts themselves
    const about = await client.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE entity = 'users' AND entity_id = ANY ($1)", [ids]);
    if (about.rows[0].n) {
      await pause('audit_log');
      await client.query("DELETE FROM audit_log WHERE entity = 'users' AND entity_id = ANY ($1)", [ids]);
      log(`   audit_log: ${about.rows[0].n} entr${about.rows[0].n === 1 ? 'y' : 'ies'} about the deleted accounts removed`);
    }

    // 2. Hand every record to an active account (random per row, same role where possible)
    let updated = 0;
    for (const c of columns) {
      const n = (await client.query(`SELECT COUNT(*)::int AS n FROM ${ident(c.table)} WHERE ${ident(c.column)} = ANY ($1)`, [ids])).rows[0].n;
      if (!n) continue;
      await pause(c.table);
      const sets = [`${ident(c.column)} = m.cands[1 + floor(random() * cardinality(m.cands))::int]`];
      if (c.roleColumn) sets.push(`${ident(c.roleColumn)} = m.new_role`);
      if (await hasCol(c.table, 'last_modified')) sets.push("last_modified = (NOW() AT TIME ZONE 'UTC')");
      const res = await client.query(
        `UPDATE ${ident(c.table)} AS t SET ${sets.join(', ')} FROM purge_map m WHERE t.${ident(c.column)} = m.old_id`);
      updated += res.rowCount;
      log(`   ${c.table}.${c.column}: ${res.rowCount}${c.roleColumn ? ` (and ${c.roleColumn})` : ''}`);
    }

    // 3. User ids written inside the audit trail's JSON details
    for (const p of plan) {
      const quoted = JSON.stringify(p.old_id); // only whole JSON strings, never part of another value
      const hits = (await client.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE strpos(details, $1) > 0`, [quoted])).rows[0].n;
      if (!hits) continue;
      await pause('audit_log');
      await client.query(`UPDATE audit_log SET details = replace(details, $1, $2) WHERE strpos(details, $1) > 0`,
        [quoted, JSON.stringify(p.candidates[Math.floor(Math.random() * p.candidates.length)])]);
      log(`   audit_log.details: ${hits} mention(s) of ${p.username}`);
    }

    // 4. Nothing may still point at them; then delete the accounts (their sessions go with them)
    for (const c of columns) {
      const n = (await client.query(`SELECT COUNT(*)::int AS n FROM ${ident(c.table)} WHERE ${ident(c.column)} = ANY ($1)`, [ids])).rows[0].n;
      if (n) throw new Error(`${c.table}.${c.column} still names a deactivated account. Nothing was saved.`);
    }
    await client.query('DELETE FROM revoked_sessions WHERE user_id = ANY ($1)', [ids]);
    const del = await client.query('DELETE FROM users WHERE user_id = ANY ($1) AND is_active = FALSE', [ids]);
    if (del.rowCount !== ids.length) throw new Error('An account changed during the clean-up. Nothing was saved.');

    for (const table of paused.splice(0)) await client.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER USER`);
    const left = (await client.query('SELECT COUNT(*)::int AS n FROM users WHERE is_active')).rows[0].n;
    if (left !== active.length) throw new Error('The active accounts changed during the clean-up. Nothing was saved.');
    await client.query('COMMIT');
    return { deleted: del.rowCount, updated, plan };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { purgeDeactivated, describePurge, planReplacements, findUserColumns, ROLE_FALLBACK };
