// SQLite-backed D1 test adapter, including synchronous transactional batches.
// A batch may carry reads as well as writes, as on D1: each statement comes
// back as { results, meta }.
export function d1(sql, before = () => {}) {
  const returnsRows = (query) => /^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query);
  return {
    prepare(query) {
      const bound = (args = []) => {
        const runSync = () => {
          before(query, args);
          const st = sql.prepare(query);
          if (returnsRows(query)) {
            const results = st.all(...args);
            return { results, meta: { changes: /^\s*(SELECT|WITH)\b/i.test(query) ? 0 : results.length } };
          }
          const r = st.run(...args);
          return { results: [], meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        };
        return {
          bind: (...values) => bound(values),
          first: async () => { before(query, args); return sql.prepare(query).get(...args) || null; },
          all: async () => { before(query, args); return { results: sql.prepare(query).all(...args) }; },
          run: async () => runSync(), runSync,
        };
      };
      return bound();
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((stmt) => stmt.runSync());
        sql.exec('COMMIT');
        return results;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// For the hand-written D1 mocks that answer by SQL substring: a batch that
// runs each statement through the mock's own first/all/run, the way the code
// would have read it one statement at a time. A read is answered by all();
// when that comes back empty, by first() — the mocks answer single-row reads
// (settings, a firing by id) only there.
export function withBatch(db) {
  const tag = (stmt, sql) => {
    if (!stmt || typeof stmt !== 'object') return stmt;
    const out = { ...stmt, sql };
    if (stmt.bind) out.bind = (...args) => tag(stmt.bind(...args), sql);
    return out;
  };
  return {
    ...db,
    prepare(sql) { return tag(db.prepare(sql), sql); },
    async batch(statements) {
      const out = [];
      for (const s of statements) {
        if (/^\s*(SELECT|WITH)\b/i.test(s.sql) || /\bRETURNING\b/i.test(s.sql)) {
          let results = s.all ? ((await s.all()) || {}).results || [] : [];
          if (!results.length && s.first) {
            const one = await s.first();
            results = one ? [one] : [];
          }
          out.push({ results, meta: { changes: results.length } });
        } else {
          out.push({ results: [], ...(await s.run()) });
        }
      }
      return out;
    },
  };
}
