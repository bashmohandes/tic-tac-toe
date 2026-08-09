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

interface StoredRivalry {
  aWins: number
  bWins: number
  draws: number
}

function rivalryKey(firstId: string, secondId: string) {
  return firstId < secondId
    ? {
        key: `${firstId}:${secondId}`,
        firstIsA: true,
      }
    : {
        key: `${secondId}:${firstId}`,
        firstIsA: false,
      }
}

export class InMemoryProfileStore implements ProfileStore {
  readonly backend = 'memory' as const
  private readonly profiles = new Map<string, StoredPlayerProfile>()
  private readonly rivalries = new Map<string, StoredRivalry>()

  async initialize(): Promise<void> {}

  async create(profile: NewPlayerProfile): Promise<StoredPlayerProfile> {
    const stored: StoredPlayerProfile = {
      ...profile,
      record: {
        wins: 0,
        losses: 0,
        draws: 0,
      },
    }
    this.profiles.set(stored.id, stored)
    return structuredClone(stored)
  }

  async find(profileId: string): Promise<StoredPlayerProfile | null> {
    const profile = this.profiles.get(profileId)
    return profile ? structuredClone(profile) : null
  }

  async update(
    profileId: string,
    displayName: string,
    avatarKey: PlayerAvatarKey,
  ): Promise<StoredPlayerProfile> {
    const profile = this.profiles.get(profileId)

    if (!profile) {
      throw new Error('Player profile not found')
    }

    const updated = {
      ...profile,
      displayName,
      avatarKey,
    }
    this.profiles.set(profileId, updated)
    return structuredClone(updated)
  }

  async getRivalry(
    xProfileId: string,
    oProfileId: string,
  ): Promise<RivalryRecord> {
    const { key, firstIsA } = rivalryKey(xProfileId, oProfileId)
    const rivalry = this.rivalries.get(key) ?? {
      aWins: 0,
      bWins: 0,
      draws: 0,
    }

    return {
      xWins: firstIsA ? rivalry.aWins : rivalry.bWins,
      oWins: firstIsA ? rivalry.bWins : rivalry.aWins,
      draws: rivalry.draws,
    }
  }

  async recordRound(
    xProfileId: string,
    oProfileId: string,
    outcome: RoundOutcome,
  ): Promise<void> {
    const xProfile = this.profiles.get(xProfileId)
    const oProfile = this.profiles.get(oProfileId)

    if (!xProfile || !oProfile) {
      throw new Error('Round profiles not found')
    }

    if (outcome === 'draw') {
      this.profiles.set(xProfileId, {
        ...xProfile,
        record: {
          ...xProfile.record,
          draws: xProfile.record.draws + 1,
        },
      })
      this.profiles.set(oProfileId, {
        ...oProfile,
        record: {
          ...oProfile.record,
          draws: oProfile.record.draws + 1,
        },
      })
    } else {
      const winnerId = outcome === 'X' ? xProfileId : oProfileId
      const loserId = outcome === 'X' ? oProfileId : xProfileId
      const winner = this.profiles.get(winnerId)
      const loser = this.profiles.get(loserId)

      if (!winner || !loser) {
        throw new Error('Round profiles not found')
      }

      this.profiles.set(winnerId, {
        ...winner,
        record: {
          ...winner.record,
          wins: winner.record.wins + 1,
        },
      })
      this.profiles.set(loserId, {
        ...loser,
        record: {
          ...loser.record,
          losses: loser.record.losses + 1,
        },
      })
    }

    const { key, firstIsA } = rivalryKey(xProfileId, oProfileId)
    const rivalry = this.rivalries.get(key) ?? {
      aWins: 0,
      bWins: 0,
      draws: 0,
    }
    const aWon =
      (outcome === 'X' && firstIsA) ||
      (outcome === 'O' && !firstIsA)
    const bWon =
      (outcome === 'X' && !firstIsA) ||
      (outcome === 'O' && firstIsA)

    this.rivalries.set(key, {
      aWins: rivalry.aWins + (aWon ? 1 : 0),
      bWins: rivalry.bWins + (bWon ? 1 : 0),
      draws: rivalry.draws + (outcome === 'draw' ? 1 : 0),
    })
  }

  async close(): Promise<void> {}
}
