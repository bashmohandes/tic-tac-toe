import { Pool, type PoolConfig } from 'pg'
import {
  persistedRoomSchema,
  type CachedCommandResponse,
  type PersistedRoom,
  type RoomStateStore,
  type RoomStoreMutation,
} from './store'

interface PostgresRoomStateStoreOptions {
  readonly connectionString: string
  readonly requireSsl?: boolean
}

interface RoomRow {
  readonly state: unknown
}

interface ReceiptRow {
  readonly response: CachedCommandResponse
}

const RECEIPT_CLEANUP_INTERVAL_MS = 5 * 60_000

export class PostgresRoomStateStore implements RoomStateStore {
  readonly backend = 'postgres' as const
  private readonly pool: Pool
  private nextReceiptCleanupAt = 0

  constructor(options: PostgresRoomStateStoreOptions) {
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      application_name: 'tic-tac-toe-room-state',
      max: 3,
    }

    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false }
    }

    this.pool = new Pool(poolConfig)
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS active_game_rooms (
        room_id UUID PRIMARY KEY,
        room_code CHAR(6) NOT NULL UNIQUE,
        state JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS active_game_rooms_expires_at_idx
        ON active_game_rooms (expires_at);

      CREATE TABLE IF NOT EXISTS game_command_receipts (
        command_key CHAR(64) PRIMARY KEY,
        response JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS game_command_receipts_expires_at_idx
        ON game_command_receipts (expires_at);

      DELETE FROM active_game_rooms WHERE expires_at <= NOW();
      DELETE FROM game_command_receipts WHERE expires_at <= NOW();
    `)
  }

  async loadActiveRooms(now: number): Promise<readonly PersistedRoom[]> {
    const result = await this.pool.query<RoomRow>(
      `
        SELECT state
        FROM active_game_rooms
        WHERE expires_at > $1
        ORDER BY updated_at ASC
      `,
      [new Date(now).toISOString()],
    )
    const rooms: PersistedRoom[] = []

    for (const row of result.rows) {
      const parsed = persistedRoomSchema.safeParse(row.state)

      if (parsed.success) {
        rooms.push(parsed.data)
      } else {
        console.error(
          'Stored room state failed validation and was skipped.',
          parsed.error,
        )
      }
    }

    return rooms
  }

  async findReceipt(
    key: string,
    now: number,
  ): Promise<CachedCommandResponse | null> {
    if (now >= this.nextReceiptCleanupAt) {
      this.nextReceiptCleanupAt = now + RECEIPT_CLEANUP_INTERVAL_MS
      await this.pool.query(
        'DELETE FROM game_command_receipts WHERE expires_at <= $1',
        [new Date(now).toISOString()],
      )
    }

    const result = await this.pool.query<ReceiptRow>(
      `
        SELECT response
        FROM game_command_receipts
        WHERE command_key = $1
          AND expires_at > $2
      `,
      [key, new Date(now).toISOString()],
    )

    return result.rows[0]?.response ?? null
  }

  async commit(mutation: RoomStoreMutation): Promise<void> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')

      if (mutation.deleteRoomId) {
        await client.query(
          'DELETE FROM active_game_rooms WHERE room_id = $1',
          [mutation.deleteRoomId],
        )
      }

      if (mutation.upsert) {
        await client.query(
          `
            INSERT INTO active_game_rooms (
              room_id,
              room_code,
              state,
              expires_at
            )
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (room_id)
            DO UPDATE SET
              room_code = EXCLUDED.room_code,
              state = EXCLUDED.state,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
          `,
          [
            mutation.upsert.id,
            mutation.upsert.code,
            JSON.stringify(mutation.upsert),
            new Date(mutation.upsert.expiresAt).toISOString(),
          ],
        )
      }

      if (mutation.receipt) {
        await client.query(
          `
            INSERT INTO game_command_receipts (
              command_key,
              response,
              expires_at
            )
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (command_key)
            DO UPDATE SET
              response = EXCLUDED.response,
              expires_at = EXCLUDED.expires_at
          `,
          [
            mutation.receipt.key,
            JSON.stringify(mutation.receipt.response),
            new Date(mutation.receipt.expiresAt).toISOString(),
          ],
        )
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
