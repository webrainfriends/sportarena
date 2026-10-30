// Federation renewal campaigns (#574): which records a campaign covers, and where each stands. A campaign never copies state: whether a record was
// renewed is read live from the renewal chain (`previous_id`), so it can never disagree with the affiliation or licence itself.

const SPEC = {
  affiliation: { table: 'fed_affiliations', alias: 'r', end: 'effective_to', inForce: "r.status = 'approved'", kindTable: 'fed_affiliation_categories', kindCol: 'category_id', sportSql: 'k.sport_id',
    done: "n.status = 'approved'", open: "n.status IN ('draft','submitted','under_review','needs_info')" },
  licence: { table: 'fed_licences', alias: 'r', end: 'expires_on', inForce: "r.status = 'active'", kindTable: 'fed_licence_types', kindCol: 'type_id', sportSql: 'k.sport_id',
    done: "n.status = 'active'", open: "n.status IN ('draft','submitted','under_review','needs_info')" },
};
export const campaignKinds = Object.keys(SPEC);

/** Where a covered record stands today: renewed (a successor is in force), in_progress (a successor is being processed), lapsed (ran out, nothing renewed) or awaiting. */
export const renewalStateSql = (target) => {
  const s = SPEC[target];
  return `CASE WHEN EXISTS (SELECT 1 FROM ${s.table} n WHERE n.previous_id=r.id AND ${s.done}) THEN 'renewed'
    WHEN EXISTS (SELECT 1 FROM ${s.table} n WHERE n.previous_id=r.id AND ${s.open}) THEN 'in_progress'
    WHEN r.${s.end} < current_date THEN 'lapsed' ELSE 'awaiting' END`;
};

/** Records a campaign (saved or being previewed) covers: in force, ending inside its window, in its categories, jurisdictions and sport, and not already renewed. */
export async function coveredRecords(c, camp, { limit = 5000 } = {}) {
  const s = SPEC[camp.target];
  const rows = await c.query(
    `SELECT r.id, r.jurisdiction_id, r.${s.end}::text AS ends_on FROM ${s.table} r JOIN ${s.kindTable} k ON k.id=r.${s.kindCol}
      WHERE r.body_id=$1 AND ${s.inForce} AND r.${s.end} BETWEEN $2 AND $3
        AND (cardinality($4::uuid[]) = 0 OR r.${s.kindCol} = ANY($4)) AND (cardinality($5::uuid[]) = 0 OR r.jurisdiction_id = ANY($5)) AND ($6::uuid IS NULL OR ${s.sportSql} = $6)
        AND NOT EXISTS (SELECT 1 FROM ${s.table} n WHERE n.previous_id=r.id AND ${s.done})
      ORDER BY r.${s.end}, r.id LIMIT $7`,
    [camp.body_id, camp.window_from, camp.window_to, camp.category_ids ?? [], camp.jurisdiction_ids ?? [], camp.sport_id ?? null, limit]);
  return rows.rows;
}

/** Who hears about a covered record: a club's owners and admins, or a licence's holder and applicant. */
export async function contactsOf(c, target, subjectId) {
  if (target === 'affiliation') {
    const r = await c.query("SELECT m.user_id FROM fed_affiliations a JOIN organisation_members m ON m.organisation_id=a.organisation_id AND m.status='active' AND m.role IN ('owner','admin') WHERE a.id=$1", [subjectId]);
    return r.rows.map((x) => x.user_id);
  }
  const r = await c.query('SELECT holder_id, applicant_id FROM fed_licences WHERE id=$1', [subjectId]);
  return r.rows[0] ? [...new Set([r.rows[0].holder_id, r.rows[0].applicant_id])] : [];
}

