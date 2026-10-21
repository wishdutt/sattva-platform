/** Applies pending Postgres migrations: DATABASE_URL=… npm run migrate -w @lsp/api */
import { migrate } from '../store/postgres';
import { MIGRATIONS } from '../store/postgres-schema';
import { createPgDatabase } from '../store/sql';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = await createPgDatabase(url, { max: 1, ssl: process.env.DATABASE_SSL === 'true' });
try {
  await migrate(db);
  console.info(`Schema is at version ${MIGRATIONS.at(-1)!.version}`);
} finally {
  await db.close();
}
