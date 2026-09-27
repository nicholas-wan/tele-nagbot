// SQLite-backed D1 test adapter, including synchronous transactional batches.
export function d1(sql, before = () => {}) {
  return {
    prepare(query) {
      const bound = (args = []) => {
        const runSync = () => {
          before(query, args);
          const r = sql.prepare(query).run(...args);
          return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
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
