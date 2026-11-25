import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** @id CODE-PROJ-002 @implements REQ-PROJ-001 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1747289123)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, sha256 text NOT NULL)',
    );
    const directory = new URL('../db/migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].sha256 !== hash) throw new Error('Applied migration has changed.');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name, sha256) VALUES($1,$2)', [name, hash]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  try {
    await migrate(pool);
    console.info('Database migrations applied.');
  } catch {
    console.error(
      'Migration failed. Check database availability, privileges and migration integrity.',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
