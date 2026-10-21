/** Minimal SQL client abstraction so the Postgres store runs on node-postgres (prod) or PGlite (tests/dev). */
export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
  /** Runs a multi-statement script with no parameters (simple query protocol), e.g. migrations. */
  exec(script: string): Promise<void>;
}

export interface SqlDatabase extends Sql {
  /** Runs `fn` in a READ COMMITTED transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** node-postgres pool adapter. */
export async function createPgDatabase(connectionString: string, opts: { max?: number; ssl?: boolean } = {}): Promise<SqlDatabase> {
  const { default: pg } = await import('pg');
  // Return BIGINT/NUMERIC as numbers (our counters are small) and keep timestamps as Date.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
  });
  const wrap = (client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await client.query(text, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async exec(script: string) {
      // node-postgres uses the simple protocol (multi-statement allowed) when no params are given.
      await client.query(script);
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * PGlite adapter (Postgres compiled to WASM, in-process). Used by tests and the optional
 * single-node `STORE=pglite` dev mode. PGlite has one connection, so transactions are serialized.
 */
export async function createPgliteDatabase(dataDir?: string): Promise<SqlDatabase> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  const wrap = (q: {
    query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
    exec: (t: string) => Promise<unknown>;
  }): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await q.query(text, params);
      return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
    },
    async exec(script: string) {
      await q.exec(script);
    },
  });
  return {
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}
