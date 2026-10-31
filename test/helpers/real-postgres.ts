// A throwaway Postgres database with Evolution's own migrations applied, for a
// test whose subject is what the database itself does (foreign keys, cascades,
// unique constraints), which the in-memory Prisma (fake-prisma.ts) cannot model.
//
// The server is FORK_TEST_PG_URL (default postgresql://127.0.0.1:5432/postgres)
// and must be on the loopback address. Each call creates one database, applies
// prisma/postgresql-migrations in order, and returns a real PrismaClient on it;
// drop() removes the database.
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const MIGRATIONS = new URL('../../prisma/postgresql-migrations/', import.meta.url).pathname;

export const pgServerUrl = () => process.env.FORK_TEST_PG_URL ?? 'postgresql://127.0.0.1:5432/postgres';

export async function throwawayDatabase(): Promise<{ url: string; prisma: PrismaClient; drop: () => Promise<void> }> {
  const server = new URL(pgServerUrl());
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)) {
    throw new Error(`FORK_TEST_PG_URL must be a loopback server, not ${server.hostname}`);
  }
  const name = `evo_fork_test_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: server.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const dbUrl = new URL(server.toString());
  dbUrl.pathname = `/${name}`;
  // libpq defaults the user to the OS user; Prisma's engine does not.
  if (!dbUrl.username) dbUrl.username = userInfo().username;
  const url = dbUrl.toString();

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  for (const dir of readdirSync(MIGRATIONS)
    .filter((d) => /^\d/.test(d))
    .sort()) {
    await db.query(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  await db.end();

  const prisma = new PrismaClient({ datasourceUrl: url });
  return {
    url,
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      const c = new pg.Client({ connectionString: server.toString() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}
