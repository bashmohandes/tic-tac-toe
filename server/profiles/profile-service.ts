import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import type { HistoryEventDraft } from '../../src/history'
import type {
  PlayerProfileSession,
  ProfileCredentials,
  PublicPlayerProfile,
  RivalryRecord,
  ValidatedProfileSessionPayload,
} from '../../src/game/protocol'
import type {
  ProfileStore,
  RoundOutcome,
  StoredPlayerProfile,
} from './store'

interface ProfileServiceOptions {
  readonly now?: () => Date
  readonly onHistoryEvent?: (event: HistoryEventDraft) => void
}

export class InvalidProfileError extends Error {}

function publicProfile(profile: StoredPlayerProfile): PublicPlayerProfile {
  return {
    id: profile.id,
    displayName: profile.displayName,
    avatarKey: profile.avatarKey,
    record: profile.record,
    createdAt: profile.createdAt,
  }
}

export class ProfileService {
  readonly backend: ProfileStore['backend']
  private readonly store: ProfileStore
  private readonly now: () => Date
  private readonly onHistoryEvent: (event: HistoryEventDraft) => void
  private initialized = false
  private closed = false
  private currentStatus: 'starting' | 'ready' | 'degraded' | 'closed' =
    'starting'

  constructor(store: ProfileStore, options: ProfileServiceOptions = {}) {
    this.store = store
    this.backend = store.backend
    this.now = options.now ?? (() => new Date())
    this.onHistoryEvent = options.onHistoryEvent ?? (() => undefined)
  }

  get status() {
    return this.currentStatus
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.store.initialize()
    this.initialized = true
    this.currentStatus = 'ready'
  }

  async ensureSession(
    payload: ValidatedProfileSessionPayload,
  ): Promise<PlayerProfileSession> {
    if (!payload.credentials) {
      if (!payload.displayName || !payload.avatarKey) {
        throw new InvalidProfileError('Profile details are required.')
      }

      return this.create(payload.displayName, payload.avatarKey)
    }

    const profile = await this.authenticate(payload.credentials)

    if (
      payload.displayName &&
      payload.avatarKey &&
      (profile.displayName !== payload.displayName ||
        profile.avatarKey !== payload.avatarKey)
    ) {
      const updated = await this.store.update(
        profile.id,
        payload.displayName,
        payload.avatarKey,
      )
      this.onHistoryEvent({
        type: 'profile_updated',
        payload: {
          avatarKey: updated.avatarKey,
          displayName: updated.displayName,
          profileId: updated.id,
        },
      })

      return {
        credentials: payload.credentials,
        profile: publicProfile(updated),
      }
    }

    return {
      credentials: payload.credentials,
      profile,
    }
  }

  async authenticate(
    credentials: ProfileCredentials,
  ): Promise<PublicPlayerProfile> {
    const stored = await this.store.find(credentials.profileId)

    if (
      !stored ||
      !this.hashesMatch(
        this.hashToken(credentials.profileToken),
        stored.tokenHash,
      )
    ) {
      throw new InvalidProfileError('The saved player profile is invalid.')
    }

    return publicProfile(stored)
  }

  async getRivalry(
    xProfileId: string,
    oProfileId: string,
  ): Promise<RivalryRecord> {
    return this.store.getRivalry(xProfileId, oProfileId)
  }

  async recordRound(
    xProfileId: string,
    oProfileId: string,
    outcome: RoundOutcome,
  ): Promise<void> {
    try {
      await this.store.recordRound(xProfileId, oProfileId, outcome)
      this.currentStatus = 'ready'
    } catch (error) {
      this.currentStatus = 'degraded'
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    this.currentStatus = 'closed'
    await this.store.close()
  }

  private async create(
    displayName: string,
    avatarKey: PublicPlayerProfile['avatarKey'],
  ): Promise<PlayerProfileSession> {
    const profileToken = randomBytes(32).toString('base64url')
    const stored = await this.store.create({
      id: randomUUID(),
      tokenHash: this.hashToken(profileToken),
      displayName,
      avatarKey,
      createdAt: this.now().toISOString(),
    })
    const credentials = {
      profileId: stored.id,
      profileToken,
    }

    this.onHistoryEvent({
      type: 'profile_created',
      payload: {
        avatarKey: stored.avatarKey,
        displayName: stored.displayName,
        profileId: stored.id,
      },
    })

    return {
      credentials,
      profile: publicProfile(stored),
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private hashesMatch(first: string, second: string): boolean {
    const firstBytes = Buffer.from(first)
    const secondBytes = Buffer.from(second)

    return (
      firstBytes.length === secondBytes.length &&
      timingSafeEqual(firstBytes, secondBytes)
    )
  }
}
