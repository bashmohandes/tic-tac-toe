import { Pool, type PoolConfig } from 'pg'
import {
  type HistoryEvent,
  type HistoryEventType,
  type HistoryPayload,
  type HistorySummary,
} from '../../src/history'
import type { HistoryEventQuery, HistoryStore } from './store'

interface PostgresHistoryStoreOptions {
  readonly connectionString: string
  readonly retentionDays?: number
  readonly requireSsl?: boolean
}

interface EventRow {
  readonly event_id: string
  readonly occurred_at: Date | string
  readonly event_type: HistoryEventType
  readonly room_id: string | null
  readonly match_id: string | null
  readonly instance_id: string
  readonly release_id: string | null
  readonly payload: HistoryPayload
  readonly schema_version: number
}

function toCount(value: unknown): number {
  const count = Number(value)
  return Number.isFinite(count) ? count : 0
}

function toHistoryEvent(row: EventRow): HistoryEvent {
  return {
    eventId: row.event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type,
    roomId: row.room_id,
    matchId: row.match_id,
    instanceId: row.instance_id,
    releaseId: row.release_id,
    payload: row.payload,
    schemaVersion: row.schema_version,
  }
}

export class PostgresHistoryStore implements HistoryStore {
  readonly backend = 'postgres' as const
  private readonly pool: Pool
  private readonly retentionDays: number

  constructor(options: PostgresHistoryStoreOptions) {
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      application_name: 'tic-tac-toe-history',
      max: 5,
    }

    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false }
    }

    this.pool = new Pool(poolConfig)
    this.retentionDays = Math.max(0, options.retentionDays ?? 365)
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS game_history_events (
        id BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL UNIQUE,
        occurred_at TIMESTAMPTZ NOT NULL,
        event_type TEXT NOT NULL,
        room_id UUID,
        match_id UUID,
        instance_id TEXT NOT NULL,
        release_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        schema_version SMALLINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS game_history_events_occurred_at_idx
        ON game_history_events (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS game_history_events_room_idx
        ON game_history_events (room_id, occurred_at DESC)
        WHERE room_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS game_history_events_match_idx
        ON game_history_events (match_id, occurred_at ASC)
        WHERE match_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS game_history_events_type_idx
        ON game_history_events (event_type, occurred_at DESC);
    `)

    if (this.retentionDays > 0) {
      await this.pool.query(
        `
          DELETE FROM game_history_events
          WHERE occurred_at < NOW() - ($1 * INTERVAL '1 day')
        `,
        [this.retentionDays],
      )
    }
  }

  async append(events: readonly HistoryEvent[]): Promise<void> {
    if (events.length === 0) {
      return
    }

    const values: unknown[] = []
    const rows = events.map((event, index) => {
      const offset = index * 9
      values.push(
        event.eventId,
        event.occurredAt,
        event.type,
        event.roomId,
        event.matchId,
        event.instanceId,
        event.releaseId,
        JSON.stringify(event.payload),
        event.schemaVersion,
      )

      return `(
        $${offset + 1}, $${offset + 2}, $${offset + 3},
        $${offset + 4}, $${offset + 5}, $${offset + 6},
        $${offset + 7}, $${offset + 8}::jsonb, $${offset + 9}
      )`
    })

    await this.pool.query(
      `
        INSERT INTO game_history_events (
          event_id,
          occurred_at,
          event_type,
          room_id,
          match_id,
          instance_id,
          release_id,
          payload,
          schema_version
        )
        VALUES ${rows.join(',')}
        ON CONFLICT (event_id) DO NOTHING
      `,
      values,
    )
  }

  async getEvents(
    query: HistoryEventQuery,
  ): Promise<readonly HistoryEvent[]> {
    const values: unknown[] = [query.from.toISOString()]
    let beforeClause = ''

    if (query.before) {
      values.push(query.before.toISOString())
      beforeClause = `AND occurred_at < $${values.length}`
    }

    values.push(query.limit)
    const result = await this.pool.query<EventRow>(
      `
        SELECT
          event_id,
          occurred_at,
          event_type,
          room_id,
          match_id,
          instance_id,
          release_id,
          payload,
          schema_version
        FROM game_history_events
        WHERE occurred_at >= $1
          ${beforeClause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${values.length}
      `,
      values,
    )

    return result.rows.map(toHistoryEvent)
  }

  async getSummary(from: Date, to: Date): Promise<HistorySummary> {
    const result = await this.pool.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE event_type = 'room_created'
          ) AS rooms_created,
          COUNT(*) FILTER (
            WHERE event_type = 'match_started'
          ) AS matches_started,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
          ) AS rounds_completed,
          COUNT(*) FILTER (
            WHERE event_type = 'move_played'
          ) AS moves_played,
          COUNT(*) FILTER (
            WHERE event_type = 'player_joined'
          ) AS players_joined,
          COUNT(*) FILTER (
            WHERE event_type = 'join_rejected'
          ) AS join_rejections,
          COUNT(*) FILTER (
            WHERE event_type = 'player_disconnected'
          ) AS disconnects,
          COUNT(*) FILTER (
            WHERE event_type = 'player_reconnected'
          ) AS reconnects,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'X'
          ) AS x_wins,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'O'
          ) AS o_wins,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'draw'
          ) AS draws
        FROM game_history_events
        WHERE occurred_at >= $1
          AND occurred_at <= $2
      `,
      [from.toISOString(), to.toISOString()],
    )
    const row = result.rows[0] ?? {}

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      counts: {
        roomsCreated: toCount(row.rooms_created),
        matchesStarted: toCount(row.matches_started),
        roundsCompleted: toCount(row.rounds_completed),
        movesPlayed: toCount(row.moves_played),
        playersJoined: toCount(row.players_joined),
        joinRejections: toCount(row.join_rejections),
        disconnects: toCount(row.disconnects),
        reconnects: toCount(row.reconnects),
      },
      outcomes: {
        xWins: toCount(row.x_wins),
        oWins: toCount(row.o_wins),
        draws: toCount(row.draws),
      },
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
