import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Both query surfaces over one connection: the Drizzle builder and the raw
 * postgres.js tag. Inside a transaction they are the *same* connection, so a
 * caller can mix the two and still get one atomic unit — which matters because
 * the knowledge indexer writes vectors and jsonb through raw SQL and
 * everything else through Drizzle.
 */
export interface DbContext {
  db: Db;
  /**
   * `ISql` rather than `Sql`: it is the tag interface a pool connection and a
   * transaction connection genuinely share. `TransactionSql` has no `end`,
   * `listen` or `options` — correctly, since none of them mean anything
   * mid-transaction — so typing this as `Sql` would exclude the transaction
   * case this interface exists to cover.
   */
  sql: postgres.ISql;
}

export interface DbHandle extends DbContext {
  /**
   * Run `fn` inside one transaction. The context handed to it is bound to the
   * transaction's connection; using the outer handle inside `fn` would open a
   * second connection that cannot see the uncommitted work and would not roll
   * back with it. Throwing from `fn` rolls the whole unit back.
   */
  transaction: <T>(fn: (tx: DbContext) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

export function createDb(connectionString: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(connectionString, {
    max: opts.max ?? 10,
    // Vectors and tsvector come back as strings; we never let postgres.js try
    // to be clever about them.
    types: {},
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    transaction: <T>(fn: (tx: DbContext) => Promise<T>): Promise<T> =>
      sql.begin((txSql) => {
        // postgres.js builds a transaction tag with only `savepoint` and
        // `prepare` on it, but Drizzle's driver reads `options.parsers` and
        // registers its own JSON serializers there. The transaction runs on a
        // connection from this pool, so the pool's options are literally the
        // ones in force for it — lending them over is accurate, not a stub.
        const client = Object.assign(txSql, { options: sql.options }) as unknown as postgres.Sql;
        // Note: the Drizzle instance this returns is bound to a connection that
        // is already inside a transaction, so `db.transaction()` on it would
        // look for a `begin` the transaction tag does not have. Nest with
        // `tx.sql.savepoint` if that is ever needed.
        return fn({ db: drizzle(client, { schema }), sql: txSql });
      }) as Promise<T>,
    close: () => sql.end({ timeout: 5 }),
  };
}

export { schema };
