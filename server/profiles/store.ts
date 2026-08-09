import type {
  PlayerAvatarKey,
  PublicPlayerProfile,
  RivalryRecord,
} from '../../src/game/protocol'

export type RoundOutcome = 'X' | 'O' | 'draw'

export interface StoredPlayerProfile extends PublicPlayerProfile {
  readonly tokenHash: string
}

export interface NewPlayerProfile {
  readonly id: string
  readonly tokenHash: string
  readonly displayName: string
  readonly avatarKey: PlayerAvatarKey
  readonly createdAt: string
}

export interface ProfileStore {
  readonly backend: 'memory' | 'postgres'
  initialize(): Promise<void>
  create(profile: NewPlayerProfile): Promise<StoredPlayerProfile>
  find(profileId: string): Promise<StoredPlayerProfile | null>
  update(
    profileId: string,
    displayName: string,
    avatarKey: PlayerAvatarKey,
  ): Promise<StoredPlayerProfile>
  getRivalry(
    xProfileId: string,
    oProfileId: string,
  ): Promise<RivalryRecord>
  recordRound(
    xProfileId: string,
    oProfileId: string,
    outcome: RoundOutcome,
  ): Promise<void>
  close(): Promise<void>
}
