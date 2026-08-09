import { describe, expect, it } from 'vitest'
import type { RoomDirectoryEntry } from './protocol'
import {
  applyRoomDirectoryDelta,
  getRoomDirectoryDeltaAction,
} from './remote-session'

function room(
  roomCode: string,
  roomName: string,
  playerCount = 1,
): RoomDirectoryEntry {
  return {
    roomCode,
    roomName,
    visibility: 'public',
    hostName: 'Alex',
    hostProfile: {
      id: '10000000-0000-4000-8000-000000000001',
      displayName: 'Alex',
      avatarKey: 'coral',
      record: { wins: 0, losses: 0, draws: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    hostConnected: true,
    playerCount,
    capacity: 2,
  }
}

describe('remote room directory', () => {
  it('applies upserts and removals in room-name order', () => {
    const updated = applyRoomDirectoryDelta(
      [room('AAAAAA', 'Zulu'), room('BBBBBB', 'Beta')],
      {
        revision: 2,
        removedRoomCodes: ['AAAAAA'],
        upserts: [
          room('BBBBBB', 'Beta', 2),
          room('CCCCCC', 'Alpha'),
        ],
      },
    )

    expect(updated.map((entry) => entry.roomCode)).toEqual([
      'CCCCCC',
      'BBBBBB',
    ])
    expect(updated[1]?.playerCount).toBe(2)
  })

  it('refreshes the full directory when a revision is missing', () => {
    expect(getRoomDirectoryDeltaAction(null, 1)).toBe('refresh')
    expect(getRoomDirectoryDeltaAction(4, 6)).toBe('refresh')
    expect(getRoomDirectoryDeltaAction(4, 5)).toBe('apply')
    expect(getRoomDirectoryDeltaAction(5, 5)).toBe('ignore')
  })
})
