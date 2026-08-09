import { Pool, type PoolClient, type PoolConfig } from 'pg'
import type {
  PlayerAvatarKey,
  RivalryRecord,
} from '../../src/game/protocol'
import type {
  NewPlayerProfile,
  ProfileStore,
  RoundOutcome,
  StoredPlayerProfile,
} from './store'

interface PostgresProfileStoreOptions {
  readonly connectionString: string
  readonly requireSsl?: boolean
}

interface ProfileRow {
  readonly id: string
  readonly token_hash: string
  readonly display_name: string
  readonly avatar_key: PlayerAvatarKey
  readonly wins: number
  readonly losses: number
  readonly draws: number
  readonly created_at: Date | string
}

interface RivalryRow {
  readonly a_wins: number
  readonly b_wins: number
  readonly draws: number
}

function toProfile(row: ProfileRow): StoredPlayerProfile {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    record: {
      wins: Number(row.wins),
      losses: Number(row.losses),
      draws: Number(row.draws),
    },
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function canonicalPair(firstId: string, secondId: string) {
  return firstId < secondId
    ? {
        profileA: firstId,
        profileB: secondId,
        firstIsA: true,
      }
    : {
        profileA: secondId,
        profileB: firstId,
        firstIsA: false,
      }
}

export class PostgresProfileStore implements ProfileStore {
  readonly backend = 'postgres' as const
  private readonly pool: Pool

  constructor(options: PostgresProfileStoreOptions) {
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      application_name: 'tic-tac-toe-profiles',
      max: 3,
    }

    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false }
    }

    this.pool = new Pool(poolConfig)
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS player_profiles (
        id UUID PRIMARY KEY,
        token_hash CHAR(64) NOT NULL,
        display_name VARCHAR(24) NOT NULL,
        avatar_key VARCHAR(16) NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
        draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_rivalries (
        profile_a UUID NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
        profile_b UUID NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
        a_wins INTEGER NOT NULL DEFAULT 0 CHECK (a_wins >= 0),
        b_wins INTEGER NOT NULL DEFAULT 0 CHECK (b_wins >= 0),
        draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_a, profile_b),
        CHECK (profile_a <> profile_b)
      );
    `)
  }

  async create(profile: NewPlayerProfile): Promise<StoredPlayerProfile> {
    const result = await this.pool.query<ProfileRow>(
      `
        INSERT INTO player_profiles (
          id,
          token_hash,
          display_name,
          avatar_key,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
      `,
      [
        profile.id,
        profile.tokenHash,
        profile.displayName,
        profile.avatarKey,
        profile.createdAt,
      ],
    )

    return toProfile(result.rows[0])
  }

  async find(profileId: string): Promise<StoredPlayerProfile | null> {
    const result = await this.pool.query<ProfileRow>(
      `
        SELECT
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
        FROM player_profiles
        WHERE id = $1
      `,
      [profileId],
    )
    const row = result.rows[0]
    return row ? toProfile(row) : null
  }

  async update(
    profileId: string,
    displayName: string,
    avatarKey: PlayerAvatarKey,
  ): Promise<StoredPlayerProfile> {
    const result = await this.pool.query<ProfileRow>(
      `
        UPDATE player_profiles
        SET
          display_name = $2,
          avatar_key = $3,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
      `,
      [profileId, displayName, avatarKey],
    )
    const row = result.rows[0]

    if (!row) {
      throw new Error('Player profile not found')
    }

    return toProfile(row)
  }

  async getRivalry(
    xProfileId: string,
    oProfileId: string,
  ): Promise<RivalryRecord> {
    const pair = canonicalPair(xProfileId, oProfileId)
    const result = await this.pool.query<RivalryRow>(
      `
        SELECT a_wins, b_wins, draws
        FROM player_rivalries
        WHERE profile_a = $1 AND profile_b = $2
      `,
      [pair.profileA, pair.profileB],
    )
    const row = result.rows[0] ?? {
      a_wins: 0,
      b_wins: 0,
      draws: 0,
    }

    return {
      xWins: pair.firstIsA ? Number(row.a_wins) : Number(row.b_wins),
      oWins: pair.firstIsA ? Number(row.b_wins) : Number(row.a_wins),
      draws: Number(row.draws),
    }
  }

  async recordRound(
    xProfileId: string,
    oProfileId: string,
    outcome: RoundOutcome,
  ): Promise<void> {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      await this.updateProfileRecords(
        client,
        xProfileId,
        oProfileId,
        outcome,
      )

      const pair = canonicalPair(xProfileId, oProfileId)
      const aWon =
        (outcome === 'X' && pair.firstIsA) ||
        (outcome === 'O' && !pair.firstIsA)
      const bWon =
        (outcome === 'X' && !pair.firstIsA) ||
        (outcome === 'O' && pair.firstIsA)

      await client.query(
        `
          INSERT INTO player_rivalries (
            profile_a,
            profile_b,
            a_wins,
            b_wins,
            draws
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (profile_a, profile_b)
          DO UPDATE SET
            a_wins = player_rivalries.a_wins + EXCLUDED.a_wins,
            b_wins = player_rivalries.b_wins + EXCLUDED.b_wins,
            draws = player_rivalries.draws + EXCLUDED.draws,
            updated_at = NOW()
        `,
        [
          pair.profileA,
          pair.profileB,
          aWon ? 1 : 0,
          bWon ? 1 : 0,
          outcome === 'draw' ? 1 : 0,
        ],
      )
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

  private async updateProfileRecords(
    client: PoolClient,
    xProfileId: string,
    oProfileId: string,
    outcome: RoundOutcome,
  ): Promise<void> {
    if (outcome === 'draw') {
      await client.query(
        `
          UPDATE player_profiles
          SET draws = draws + 1, updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `,
        [[xProfileId, oProfileId]],
      )
      return
    }

    const winnerId = outcome === 'X' ? xProfileId : oProfileId
    const loserId = outcome === 'X' ? oProfileId : xProfileId
    await client.query(
      `
        UPDATE player_profiles
        SET wins = wins + 1, updated_at = NOW()
        WHERE id = $1
      `,
      [winnerId],
    )
    await client.query(
      `
        UPDATE player_profiles
        SET losses = losses + 1, updated_at = NOW()
        WHERE id = $1
      `,
      [loserId],
    )
  }
}
