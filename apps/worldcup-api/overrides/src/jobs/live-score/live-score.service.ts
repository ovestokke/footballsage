import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../lib/db/db.module.js';
import type { DrizzleDb } from '../../lib/db/db.module.js';
import { matches, teams } from '../../lib/db/schema.js';
import type { LiveScorePort } from '../../domain/live-score.port.js';
import type { NormalizedMatchUpdate } from '../../adapters/espn/espn.types.js';
import type { EspnSummaryClient } from '../../adapters/espn/espn.summary-client.js';
import { normalizeEspnEvents } from '../../adapters/espn/espn-events.normalize.js';
import type { NormalizedEvent } from '../../adapters/espn/espn-events.normalize.js';

export const LIVE_SCORE_ADAPTERS = Symbol('LIVE_SCORE_ADAPTERS');

export interface CanonicalMatch {
  id: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeFifa: string | null;
  awayFifa: string | null;
  espnEventId: string | null;
  groupId: string | null;
  kickoffUtc: Date | null;
}

export interface MatchLookup {
  byEspnId: Map<string, CanonicalMatch>;
  byPair: Map<string, CanonicalMatch>;
  /** Only matches with at least one NULL team (i.e. unresolved knockout slots). */
  byKickoff: Map<string, CanonicalMatch[]>;
}

export type Resolution =
  | { kind: 'id' | 'pair'; match: CanonicalMatch }
  | { kind: 'kickoff'; match: CanonicalMatch } // fresh knockout assignment
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

/**
 * Pure matching decision — links a source update to a canonical match.
 *
 *  1. byEspnId   — fast path once an ESPN event id is stamped
 *  2. byPair     — group matches (both teams known)
 *  3. byKickoff  — knockout matches whose teams are still NULL; matched by exact
 *                  kickoff timestamp. Returns 'kickoff' (→ assign teams from feed)
 *                  when exactly one unresolved match shares that timestamp,
 *                  or 'ambiguous' when several do (caller skips + logs).
 */
export function resolveTarget(
  u: {
    sourceEventId: string;
    homeFifa: string;
    awayFifa: string;
    kickoffUtc: Date;
  },
  lookup: MatchLookup,
): Resolution {
  const byId = lookup.byEspnId.get(u.sourceEventId);
  if (byId) return { kind: 'id', match: byId };

  const byP = lookup.byPair.get(pairKey(u.homeFifa, u.awayFifa));
  if (byP) return { kind: 'pair', match: byP };

  const candidates = lookup.byKickoff.get(u.kickoffUtc.toISOString()) ?? [];
  if (candidates.length === 1) return { kind: 'kickoff', match: candidates[0] };
  if (candidates.length > 1)
    return { kind: 'ambiguous', count: candidates.length };

  return { kind: 'none' };
}

export interface SyncResult {
  fetched: number;
  matched: number;
  updated: number;
  source: string;
}

export interface MultiDateSyncResult {
  dates: string[];
  fetched: number;
  matched: number;
  updated: number;
  errors: Array<{ date: string; message: string }>;
}

/**
 * Live-score sync service.
 *
 * Adapter chain: ESPN (1°) → worldcupjson (2°) → football-data (3°).
 * Field-based authority: this service owns status / score / minute / events.
 */
@Injectable()
export class LiveScoreService {
  private readonly logger = new Logger(LiveScoreService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    @Inject(LIVE_SCORE_ADAPTERS) private readonly adapters: LiveScorePort[],
    private readonly eventEmitter: EventEmitter2,
    @Optional() private readonly espnSummary?: EspnSummaryClient,
  ) {}

  async syncDate(date: Date = new Date()): Promise<SyncResult> {
    const startedAt = new Date();
    let source = 'unknown';
    try {
      const updates = await this.fetchWithFallback(date);
      const teamFifaMap = await this.loadTeamFifaMap();
      const result = await this.applyUpdates(updates, teamFifaMap);
      source = result.source;
      await this.writeSyncLog(source, startedAt, 'ok', result.updated, null);
      this.logger.log(
        `live-score sync ${date.toISOString().slice(0, 10)} [${source}]: ` +
          `fetched=${result.fetched} matched=${result.matched} updated=${result.updated}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.writeSyncLog(source, startedAt, 'error', 0, message);
      this.logger.error(`live-score sync failed: ${message}`);
      throw err;
    }
  }

  async syncActiveMatchWindow(
    now: Date = new Date(),
    lookBackHours = 8,
    lookAheadHours = 2,
  ): Promise<MultiDateSyncResult> {
    const from = new Date(now.getTime() - lookBackHours * 60 * 60 * 1000);
    const to = new Date(now.getTime() + lookAheadHours * 60 * 60 * 1000);
    return this.syncDistinctDates(
      sql`
        SELECT DISTINCT to_char(kickoff_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS sync_date
        FROM matches
        WHERE kickoff_utc IS NOT NULL
          AND (
            kickoff_utc BETWEEN ${from.toISOString()} AND ${to.toISOString()}
            OR status IN ('live', 'ht')
          )
        ORDER BY sync_date ASC
      `,
      'live-score active window',
    );
  }

  async syncMissingDueDates(now: Date = new Date()): Promise<MultiDateSyncResult> {
    return this.syncDistinctDates(
      sql`
        SELECT DISTINCT to_char(kickoff_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS sync_date
        FROM matches
        WHERE kickoff_utc IS NOT NULL
          AND kickoff_utc <= ${now.toISOString()}
          AND (
            status IN ('scheduled', 'live', 'ht')
            OR (status = 'ft' AND (home_score IS NULL OR away_score IS NULL))
          )
        ORDER BY sync_date ASC
      `,
      'live-score missing due dates',
    );
  }

  private async syncDistinctDates(
    query: ReturnType<typeof sql>,
    label: string,
  ): Promise<MultiDateSyncResult> {
    const rows = (await this.db.execute(query)) as { rows: { sync_date: string }[] };
    const dates = rows.rows.map((row) => row.sync_date);
    const summary: MultiDateSyncResult = {
      dates,
      fetched: 0,
      matched: 0,
      updated: 0,
      errors: [],
    };

    if (dates.length === 0) {
      this.logger.debug(`${label}: no dates`);
      return summary;
    }

    for (const date of dates) {
      try {
        const result = await this.syncDate(new Date(`${date}T12:00:00Z`));
        summary.fetched += result.fetched;
        summary.matched += result.matched;
        summary.updated += result.updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push({ date, message });
        this.logger.warn(`${label} ${date} failed: ${message}`);
      }
    }

    this.logger.log(
      `${label}: dates=${dates.length} fetched=${summary.fetched} ` +
        `matched=${summary.matched} updated=${summary.updated} errors=${summary.errors.length}`,
    );
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Adapter chain
  // ---------------------------------------------------------------------------

  private async fetchWithFallback(
    date: Date,
  ): Promise<NormalizedMatchUpdate[]> {
    const sorted = [...this.adapters].sort((a, b) => a.priority - b.priority);
    const errors: string[] = [];

    for (const adapter of sorted) {
      try {
        const updates = await adapter.fetchUpdates(date);
        if (errors.length > 0) {
          this.logger.warn(
            `Fell back to "${adapter.name}" (failed: ${errors.join(', ')})`,
          );
        }
        this.logger.debug(`live-score: using adapter "${adapter.name}"`);
        return updates;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${adapter.name}: ${msg}`);
        this.logger.warn(`Adapter "${adapter.name}" failed: ${msg}`);
      }
    }

    throw new Error(`All live-score adapters failed: ${errors.join('; ')}`);
  }

  // ---------------------------------------------------------------------------
  // DB upsert
  // ---------------------------------------------------------------------------

  private async applyUpdates(
    updates: NormalizedMatchUpdate[],
    teamFifaMap: Map<string, string>,
  ): Promise<SyncResult> {
    if (updates.length === 0) {
      return { fetched: 0, matched: 0, updated: 0, source: 'none' };
    }

    const canonical = await this.loadCanonical();
    const lookup: MatchLookup = {
      byEspnId: new Map(),
      byPair: new Map(),
      byKickoff: new Map(),
    };
    for (const m of canonical) {
      if (m.espnEventId) lookup.byEspnId.set(m.espnEventId, m);
      if (m.homeFifa && m.awayFifa)
        lookup.byPair.set(pairKey(m.homeFifa, m.awayFifa), m);
      // Unresolved knockout slots — indexed by kickoff for team assignment
      if ((!m.homeTeamId || !m.awayTeamId) && m.kickoffUtc) {
        const key = m.kickoffUtc.toISOString();
        const list = lookup.byKickoff.get(key) ?? [];
        list.push(m);
        lookup.byKickoff.set(key, list);
      }
    }

    let matched = 0;
    let updated = 0;

    for (const u of updates) {
      const res = resolveTarget(u, lookup);
      if (res.kind === 'ambiguous') {
        this.logger.warn(
          `Ambiguous kickoff match for ${u.homeFifa} vs ${u.awayFifa} ` +
            `at ${u.kickoffUtc.toISOString()} (${res.count} candidates) — skipping`,
        );
        continue;
      }
      if (res.kind === 'none') continue;
      const target = res.match;
      const isKnockoutAssignment = res.kind === 'kickoff';
      matched++;

      // For a fresh knockout slot we adopt the feed's home/away orientation;
      // otherwise we keep our canonical orientation and swap scores if needed.
      const swapped = !isKnockoutAssignment && target.homeFifa !== u.homeFifa;
      const homeScore = swapped ? u.awayScore : u.homeScore;
      const awayScore = swapped ? u.homeScore : u.awayScore;
      const homeScoreHt = swapped ? u.awayScoreHt : u.homeScoreHt;
      const awayScoreHt = swapped ? u.homeScoreHt : u.awayScoreHt;
      const homePens = swapped ? u.awayPens : u.homePens;
      const awayPens = swapped ? u.homePens : u.awayPens;

      // Resolve knockout teams from the feed (only when both FIFA codes map)
      const assignHomeId = isKnockoutAssignment
        ? teamFifaMap.get(u.homeFifa)
        : undefined;
      const assignAwayId = isKnockoutAssignment
        ? teamFifaMap.get(u.awayFifa)
        : undefined;
      const assignTeams = Boolean(assignHomeId && assignAwayId);

      const setValues: Record<string, unknown> = {
        status: u.status,
        minute: u.minute,
        homeScore,
        awayScore,
        homeScoreHt,
        awayScoreHt,
        homePens,
        awayPens,
        sourceIds: sql`coalesce(${matches.sourceIds}, '{}'::jsonb) || ${JSON.stringify({ espn: u.sourceEventId })}::jsonb`,
        updatedAt: new Date(),
      };
      if (assignTeams) {
        setValues.homeTeamId = assignHomeId;
        setValues.awayTeamId = assignAwayId;
        this.logger.log(
          `bracket: resolved match ${target.id} → ${u.homeFifa} vs ${u.awayFifa}`,
        );
      }

      await this.db
        .update(matches)
        .set(setValues)
        .where(eq(matches.id, target.id));

      this.eventEmitter.emit('match.updated', {
        matchId: target.id,
        data: {
          status: u.status,
          minute: u.minute,
          homeScore,
          awayScore,
          homePens,
          awayPens,
        },
      });

      // Sync events only for live/ht matches (not pre or post)
      if (
        (u.status === 'live' || u.status === 'ht') &&
        target.espnEventId &&
        this.espnSummary
      ) {
        await this.syncEvents(target.id, target.espnEventId, teamFifaMap);
      }

      // Trigger standings recalculation when a group match finishes
      if (u.status === 'ft' && target.groupId) {
        this.eventEmitter.emit('standings.recalculate', {
          groupId: target.groupId,
        });
      }

      updated++;
    }

    return { fetched: updates.length, matched, updated, source: 'adapter' };
  }

  // ---------------------------------------------------------------------------
  // Event sync (goals / cards from ESPN /summary)
  // ---------------------------------------------------------------------------

  private async syncEvents(
    matchId: string,
    espnEventId: string,
    teamFifaMap: Map<string, string>,
  ): Promise<void> {
    try {
      const summary = await this.espnSummary!.fetchSummary(espnEventId);
      const events = normalizeEspnEvents(summary);
      if (events.length === 0) return;

      const newGoalEvents: NormalizedEvent[] = [];

      for (const ev of events) {
        const teamId = teamFifaMap.get(ev.teamFifa) ?? null;
        // INSERT ... ON CONFLICT DO NOTHING (unique: match_id+type+minute+team_id)
        const result = (await this.db.execute(sql`
          INSERT INTO match_events (id, match_id, type, minute, team_id, player_name, detail, source, created_at)
          VALUES (gen_random_uuid(), ${matchId}, ${ev.type}, ${ev.minute}, ${teamId},
                  ${ev.playerName}, '{}'::jsonb, 'espn', now())
          ON CONFLICT (match_id, type, minute, team_id) DO NOTHING
          RETURNING id
        `)) as { rows: { id: string }[] };

        if (
          result.rows.length > 0 &&
          (ev.type === 'goal' || ev.type === 'own_goal')
        ) {
          newGoalEvents.push(ev);
        }
      }

      if (newGoalEvents.length > 0) {
        this.eventEmitter.emit('match.events.updated', {
          matchId,
          events: newGoalEvents,
        });
        this.logger.log(
          `match_events: ${newGoalEvents.length} new goal(s) for match ${matchId}`,
        );
      }
    } catch (err) {
      // Non-fatal: event sync failure must not break the score sync loop
      this.logger.warn(
        `Event sync failed for match ${matchId} (espnId=${espnEventId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async loadTeamFifaMap(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: teams.id, fifaCode: teams.fifaCode })
      .from(teams);
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.fifaCode) map.set(r.fifaCode, r.id);
    }
    return map;
  }

  private async loadCanonical(): Promise<CanonicalMatch[]> {
    // Load ALL matches (incl. knockout slots with NULL teams) so the kickoff
    // fallback can resolve and populate them from the feed.
    const rows = await this.db
      .select({
        id: matches.id,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        groupId: matches.groupId,
        kickoffUtc: matches.kickoffUtc,
        sourceIds: matches.sourceIds,
      })
      .from(matches);

    const teamRows = await this.db
      .select({ id: teams.id, fifaCode: teams.fifaCode })
      .from(teams);
    const fifaById = new Map(teamRows.map((t) => [t.id, t.fifaCode]));

    return rows.map((r) => ({
      id: r.id,
      homeTeamId: r.homeTeamId ?? null,
      awayTeamId: r.awayTeamId ?? null,
      homeFifa: r.homeTeamId ? (fifaById.get(r.homeTeamId) ?? null) : null,
      awayFifa: r.awayTeamId ? (fifaById.get(r.awayTeamId) ?? null) : null,
      espnEventId: r.sourceIds?.espn ?? null,
      groupId: r.groupId ?? null,
      kickoffUtc: r.kickoffUtc ?? null,
    }));
  }

  private async writeSyncLog(
    source: string,
    startedAt: Date,
    status: string,
    rowsUpserted: number,
    error: string | null,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO sync_log (id, source, entity, started_at, finished_at, status, rows_upserted, error)
      VALUES (gen_random_uuid(), ${source}, 'matches',
              ${startedAt.toISOString()}, ${new Date().toISOString()},
              ${status}, ${rowsUpserted}, ${error})
    `);
  }
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('-');
}
