import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../lib/db/schema.js';
import { EspnClient } from '../adapters/espn/espn.client.js';
import { EspnScoreboardAdapter } from '../adapters/espn/espn-scoreboard.adapter.js';
import { WorldcupJsonClient } from '../adapters/worldcupjson/worldcupjson.client.js';
import { WorldcupJsonScoreboardAdapter } from '../adapters/worldcupjson/worldcupjson-scoreboard.adapter.js';
import { LiveScoreService } from '../jobs/live-score/live-score.service.js';
import { StandingsCalcService } from '../jobs/standings/standings-calc.service.js';
import type { DrizzleDb } from '../lib/db/db.module.js';

function parseDateArg(arg: string | undefined): Date {
  if (!arg) {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    return today;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    throw new Error('Usage: node dist/cli/sync-live.js [YYYY-MM-DD]');
  }
  return new Date(`${arg}T12:00:00Z`);
}

async function main(): Promise<void> {
  const date = parseDateArg(process.argv[2]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema }) as DrizzleDb;
  const service = new LiveScoreService(
    db,
    [
      new EspnScoreboardAdapter(new EspnClient()),
      new WorldcupJsonScoreboardAdapter(new WorldcupJsonClient()),
    ],
    new EventEmitter2(),
  );
  const standings = new StandingsCalcService(db);

  try {
    const result = await service.syncDate(date);
    await standings.recalculateAll();
    process.stdout.write(
      `Done: ${JSON.stringify({ date: date.toISOString().slice(0, 10), ...result })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
