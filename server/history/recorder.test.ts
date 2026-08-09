// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { InMemoryHistoryStore } from './in-memory-store'
import {
  HistoryRecorder,
  sanitizeHistoryPayload,
} from './recorder'

describe('HistoryRecorder', () => {
  it('removes credentials and transport identifiers from nested payloads', () => {
    const payload = sanitizeHistoryPayload({
      roomCode: 'ABC234',
      password: 'secret-value',
      player: {
        name: 'Alex',
        sessionToken: 'session-secret',
        socket_id: 'socket-secret',
      },
      allowed: ['X', 4],
    })

    expect(payload).toEqual({
      player: {
        name: 'Alex',
      },
      allowed: ['X', 4],
    })
  })

  it('buffers events, builds summaries, and keeps opaque entity ids', async () => {
    const store = new InMemoryHistoryStore()
    const now = new Date('2026-08-08T18:00:00.000Z')
    const recorder = new HistoryRecorder(store, {
      instanceId: 'test-instance',
      releaseId: 'release-123',
      flushIntervalMs: 60_000,
      now: () => now,
    })
    await recorder.initialize()

    recorder.record({
      type: 'room_created',
      roomId: 'e07f916e-00dd-48ca-9c35-7617ec6835ce',
      payload: { visibility: 'private' },
    })
    recorder.record({
      type: 'match_started',
      roomId: 'e07f916e-00dd-48ca-9c35-7617ec6835ce',
      matchId: 'a33b8807-753d-43d6-8d65-f05474176f4a',
    })
    recorder.record({
      type: 'move_played',
      roomId: 'e07f916e-00dd-48ca-9c35-7617ec6835ce',
      matchId: 'a33b8807-753d-43d6-8d65-f05474176f4a',
      payload: { index: 0, mark: 'X' },
    })
    recorder.record({
      type: 'round_completed',
      roomId: 'e07f916e-00dd-48ca-9c35-7617ec6835ce',
      matchId: 'a33b8807-753d-43d6-8d65-f05474176f4a',
      payload: { outcome: 'X' },
    })

    const summary = await recorder.getSummary(24)
    const response = await recorder.getEvents(24, 20)

    expect(summary.counts).toMatchObject({
      roomsCreated: 1,
      matchesStarted: 1,
      roundsCompleted: 1,
      movesPlayed: 1,
    })
    expect(summary.outcomes).toEqual({
      xWins: 1,
      oWins: 0,
      draws: 0,
    })
    expect(response.events).toHaveLength(4)
    expect(response.events.map((event) => event.type)).toEqual([
      'round_completed',
      'move_played',
      'match_started',
      'room_created',
    ])
    expect(response.events[0]).toMatchObject({
      instanceId: 'test-instance',
      releaseId: 'release-123',
    })
    expect(response.events.some((event) => event.roomId === null)).toBe(false)

    await recorder.close()
  })
})
