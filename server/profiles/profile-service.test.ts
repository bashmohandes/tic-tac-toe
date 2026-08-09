// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { HistoryEventDraft } from '../../src/history'
import { InMemoryProfileStore } from './in-memory-store'
import {
  InvalidProfileError,
  ProfileService,
} from './profile-service'

describe('ProfileService', () => {
  it('issues credentials, updates public details, and rejects invalid tokens', async () => {
    const history: HistoryEventDraft[] = []
    const service = new ProfileService(new InMemoryProfileStore(), {
      now: () => new Date('2026-08-08T18:00:00.000Z'),
      onHistoryEvent: (event) => history.push(event),
    })
    await service.initialize()

    const created = await service.ensureSession({
      displayName: 'Alex',
      avatarKey: 'coral',
    })
    const updated = await service.ensureSession({
      credentials: created.credentials,
      displayName: 'Alex R',
      avatarKey: 'gold',
    })

    expect(created.credentials.profileToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(updated.profile).toMatchObject({
      id: created.profile.id,
      displayName: 'Alex R',
      avatarKey: 'gold',
      record: { wins: 0, losses: 0, draws: 0 },
    })
    await expect(
      service.authenticate({
        ...created.credentials,
        profileToken: 'x'.repeat(43),
      }),
    ).rejects.toBeInstanceOf(InvalidProfileError)
    expect(JSON.stringify(history)).not.toContain(
      created.credentials.profileToken,
    )
    expect(history.map((event) => event.type)).toEqual([
      'profile_created',
      'profile_updated',
    ])

    await service.close()
  })

  it('tracks casual records and an oriented rivalry', async () => {
    const service = new ProfileService(new InMemoryProfileStore())
    await service.initialize()
    const alex = await service.ensureSession({
      displayName: 'Alex',
      avatarKey: 'coral',
    })
    const sam = await service.ensureSession({
      displayName: 'Sam',
      avatarKey: 'teal',
    })

    await service.recordRound(alex.profile.id, sam.profile.id, 'X')
    await service.recordRound(alex.profile.id, sam.profile.id, 'draw')

    const refreshedAlex = await service.authenticate(alex.credentials)
    const refreshedSam = await service.authenticate(sam.credentials)
    const rivalry = await service.getRivalry(
      alex.profile.id,
      sam.profile.id,
    )
    const reversed = await service.getRivalry(
      sam.profile.id,
      alex.profile.id,
    )

    expect(refreshedAlex.record).toEqual({
      wins: 1,
      losses: 0,
      draws: 1,
    })
    expect(refreshedSam.record).toEqual({
      wins: 0,
      losses: 1,
      draws: 1,
    })
    expect(rivalry).toEqual({ xWins: 1, oWins: 0, draws: 1 })
    expect(reversed).toEqual({ xWins: 0, oWins: 1, draws: 1 })

    await service.close()
  })
})
