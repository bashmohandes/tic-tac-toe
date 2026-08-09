// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEventDraft } from '../src/history'
import type {
  JoinRoomResponse,
  PublicPlayerProfile,
  RivalryRecord,
  RoomCommandResponse,
  RoomDirectoryDelta,
  RoomSnapshot,
  RoomVisibility,
} from '../src/game/protocol'
import { RoomManager } from './room-manager'
import { InMemoryRoomStateStore } from './rooms/in-memory-store'

function expectJoined(response: JoinRoomResponse) {
  expect(response.ok).toBe(true)

  if (!response.ok) {
    throw new Error(response.error.message)
  }

  return response
}

async function expectCommandSucceeded(
  response: RoomCommandResponse | Promise<RoomCommandResponse>,
) {
  const resolved = await response
  expect(resolved.ok).toBe(true)

  if (!resolved.ok || !resolved.snapshot) {
    throw new Error(
      resolved.ok ? 'Missing snapshot' : resolved.error.message,
    )
  }

  return resolved.snapshot
}

async function createRoom(
  manager: RoomManager,
  options: {
    readonly name?: string
    readonly roomName?: string
    readonly visibility?: RoomVisibility
    readonly password?: string
    readonly socketId?: string
    readonly profile?: PublicPlayerProfile
  } = {},
) {
  return expectJoined(
    await manager.createRoom(
      {
        commandId: randomUUID(),
        name: options.name ?? 'Alex',
        roomName: options.roomName ?? 'Friday game',
        visibility: options.visibility ?? 'public',
        password: options.password,
        profile: options.profile,
      },
      options.socketId ?? 'socket-x',
    ),
  )
}

async function joinRoom(
  manager: RoomManager,
  host: ReturnType<typeof expectJoined>,
  options: {
    readonly name?: string
    readonly password?: string
    readonly socketId?: string
    readonly profile?: PublicPlayerProfile
    readonly rivalry?: RivalryRecord
  } = {},
) {
  return expectJoined(
    await manager.joinRoom(
      host.identity.roomCode,
      options.name ?? 'Sam',
      options.password,
      options.socketId ?? 'socket-o',
      options.profile,
      options.rivalry,
      randomUUID(),
    ),
  )
}

describe('RoomManager', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('lists a public room and assigns its second player', async () => {
    const snapshots: RoomSnapshot[] = []
    const manager = new RoomManager({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    })
    const host = await createRoom(manager)
    const directory = await manager.getDirectory()
    const guest = await joinRoom(manager, host)

    expect(directory.rooms).toEqual([
      {
        roomCode: host.identity.roomCode,
        roomName: 'Friday game',
        visibility: 'public',
        hostName: 'Alex',
        hostProfile: expect.objectContaining({
          displayName: 'Alex',
          avatarKey: 'coral',
          record: { wins: 0, losses: 0, draws: 0 },
        }),
        hostConnected: true,
        playerCount: 1,
        capacity: 2,
      },
    ])
    expect(host.identity.player).toBe('X')
    expect(guest.identity.player).toBe('O')
    expect(guest.snapshot).toMatchObject({
      roomName: 'Friday game',
      visibility: 'public',
      players: {
        X: { mark: 'X', name: 'Alex', connected: true },
        O: { mark: 'O', name: 'Sam', connected: true },
      },
    })
    expect(JSON.stringify(guest.snapshot)).not.toContain(
      host.identity.sessionToken,
    )
    expect(snapshots.at(-1)?.roomCode).toBe(host.identity.roomCode)

    manager.dispose()
  })

  it('lists private rooms without secrets and verifies their password', async () => {
    const manager = new RoomManager()
    const host = await createRoom(manager, {
      roomName: 'Locked table',
      visibility: 'private',
      password: 'correct-horse',
    })
    const serializedDirectory = JSON.stringify(await manager.getDirectory())
    const rejected = await manager.joinRoom(
      host.identity.roomCode,
      'Sam',
      'wrong-password',
      'socket-o',
    )
    const guest = await joinRoom(manager, host, {
      password: 'correct-horse',
    })

    expect(serializedDirectory).toContain('Locked table')
    expect(serializedDirectory).not.toContain('correct-horse')
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PASSWORD' },
    })
    expect(guest.snapshot.visibility).toBe('private')

    manager.dispose()
  })

  it('records replay events without room or session credentials', async () => {
    const history: HistoryEventDraft[] = []
    const manager = new RoomManager({
      onHistoryEvent: (event) => history.push(event),
    })
    const host = await createRoom(manager, {
      roomName: 'Tracked table',
      visibility: 'private',
      password: 'correct-horse',
    })
    await manager.joinRoom(
      host.identity.roomCode,
      'Sam',
      'wrong-password',
      'socket-rejected',
    )
    const guest = await joinRoom(manager, host, {
      password: 'correct-horse',
    })
    const afterMove = await expectCommandSucceeded(
      manager.playMove(
        {
          commandId: randomUUID(),
          roomCode: host.identity.roomCode,
          sessionToken: host.identity.sessionToken,
          revision: guest.snapshot.revision,
          index: 0,
        },
        'socket-x',
      ),
    )

    expect(history.map((event) => event.type)).toEqual([
      'room_created',
      'player_joined',
      'join_rejected',
      'player_joined',
      'match_started',
      'move_played',
    ])
    expect(history.at(-1)).toMatchObject({
      type: 'move_played',
      payload: {
        index: 0,
        mark: 'X',
        moveNumber: 1,
        roundNumber: 1,
      },
    })

    const serialized = JSON.stringify(history)
    expect(serialized).not.toContain('correct-horse')
    expect(serialized).not.toContain(host.identity.roomCode)
    expect(serialized).not.toContain(host.identity.sessionToken)
    expect(serialized).not.toContain('socket-x')
    expect(afterMove.match.round.board[0]).toBe('X')

    manager.dispose()
  })

  it('admits one guest when private join requests race', async () => {
    const manager = new RoomManager()
    const host = await createRoom(manager, {
      visibility: 'private',
      password: 'correct-horse',
    })

    const responses = await Promise.all([
      manager.joinRoom(
        host.identity.roomCode,
        'Sam',
        'correct-horse',
        'socket-o-1',
      ),
      manager.joinRoom(
        host.identity.roomCode,
        'Taylor',
        'correct-horse',
        'socket-o-2',
      ),
    ])
    const joined = responses.filter((response) => response.ok)
    const rejected = responses.filter((response) => !response.ok)

    expect(joined).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({
      ok: false,
      error: { code: 'ROOM_FULL' },
    })
    expect((await manager.getDirectory()).rooms[0]?.playerCount).toBe(2)

    manager.dispose()
  })

  it('creates one room when a socket submits two private rooms at once', async () => {
    const manager = new RoomManager()
    const details = {
      name: 'Alex',
      roomName: 'Locked table',
      visibility: 'private' as const,
      password: 'correct-horse',
    }
    const responses = await Promise.all([
      manager.createRoom(
        { ...details, commandId: randomUUID() },
        'socket-x',
      ),
      manager.createRoom(
        { ...details, commandId: randomUUID() },
        'socket-x',
      ),
    ])

    expect(responses.filter((response) => response.ok)).toHaveLength(1)
    expect(responses.filter((response) => !response.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'ALREADY_IN_ROOM' }),
      }),
    ])
    expect(manager.roomCount).toBe(1)

    manager.dispose()
  })

  it('returns the same seats for duplicate create and join commands', async () => {
    const history: HistoryEventDraft[] = []
    const manager = new RoomManager({
      onHistoryEvent: (event) => history.push(event),
    })
    const createCommandId = randomUUID()
    const createDetails = {
      commandId: createCommandId,
      name: 'Alex',
      roomName: 'Retry table',
      visibility: 'public' as const,
    }
    const [firstCreate, duplicateCreate] = await Promise.all([
      manager.createRoom(createDetails, 'socket-x'),
      manager.createRoom(createDetails, 'socket-x'),
    ])
    const host = expectJoined(firstCreate)
    const replayedHost = expectJoined(duplicateCreate)
    const joinCommandId = randomUUID()
    const [firstJoin, duplicateJoin] = await Promise.all([
      manager.joinRoom(
        host.identity.roomCode,
        'Sam',
        undefined,
        'socket-o',
        undefined,
        undefined,
        joinCommandId,
      ),
      manager.joinRoom(
        host.identity.roomCode,
        'Sam',
        undefined,
        'socket-o',
        undefined,
        undefined,
        joinCommandId,
      ),
    ])

    expect(replayedHost.identity).toEqual(host.identity)
    expect(expectJoined(duplicateJoin).identity).toEqual(
      expectJoined(firstJoin).identity,
    )
    expect(manager.roomCount).toBe(1)
    expect(history.filter((event) => event.type === 'room_created')).toHaveLength(
      1,
    )
    expect(history.filter((event) => event.type === 'match_started')).toHaveLength(
      1,
    )

    manager.dispose()
  })

  it('applies a duplicate move command once and replays its response', async () => {
    const history: HistoryEventDraft[] = []
    const manager = new RoomManager({
      onHistoryEvent: (event) => history.push(event),
    })
    const host = await createRoom(manager)
    const guest = await joinRoom(manager, host)
    const payload = {
      commandId: randomUUID(),
      roomCode: host.identity.roomCode,
      sessionToken: host.identity.sessionToken,
      revision: guest.snapshot.revision,
      index: 0,
    }
    const [first, duplicate] = await Promise.all([
      manager.playMove(payload, 'socket-x'),
      manager.playMove(payload, 'socket-x'),
    ])

    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({
      ok: true,
      snapshot: {
        match: {
          round: {
            board: ['X', null, null, null, null, null, null, null, null],
            moveCount: 1,
          },
        },
      },
    })
    expect(history.filter((event) => event.type === 'move_played')).toHaveLength(
      1,
    )

    manager.dispose()
  })

  it('keeps the live room available when snapshot persistence degrades', async () => {
    const roomStore = new InMemoryRoomStateStore()
    const commitError = new Error('database unavailable')
    const commitSpy = vi
      .spyOn(roomStore, 'commit')
      .mockRejectedValue(commitError)
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const manager = new RoomManager({ roomStore })
    await manager.initialize()

    const host = await createRoom(manager)

    expect(host.snapshot.players.X?.connected).toBe(true)
    expect(manager.roomCount).toBe(1)
    expect(manager.status).toBe('degraded')
    expect(commitSpy).toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(
      'Active room persistence failed.',
      commitError,
    )

    await manager.close()
  })

  it('enforces turns, move validity, and snapshot revisions', async () => {
    const manager = new RoomManager()
    const host = await createRoom(manager)
    const guest = await joinRoom(manager, host)
    const roomCode = host.identity.roomCode

    const outOfTurn = await manager.playMove(
      {
        commandId: randomUUID(),
        roomCode,
        sessionToken: guest.identity.sessionToken,
        revision: guest.snapshot.revision,
        index: 0,
      },
      'socket-o',
    )
    expect(outOfTurn).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_TURN' },
    })

    const afterX = await expectCommandSucceeded(
      manager.playMove(
        {
          commandId: randomUUID(),
          roomCode,
          sessionToken: host.identity.sessionToken,
          revision: guest.snapshot.revision,
          index: 0,
        },
        'socket-x',
      ),
    )
    const staleMove = await manager.playMove(
      {
        commandId: randomUUID(),
        roomCode,
        sessionToken: guest.identity.sessionToken,
        revision: guest.snapshot.revision,
        index: 4,
      },
      'socket-o',
    )

    expect(afterX.match.round.board[0]).toBe('X')
    expect(staleMove).toMatchObject({
      ok: false,
      error: { code: 'STALE_STATE' },
    })

    manager.dispose()
  })

  it('pauses play during a disconnect and resumes the saved seat', async () => {
    const manager = new RoomManager({ disconnectGraceMs: 5_000 })
    const host = await createRoom(manager)
    const guest = await joinRoom(manager, host)

    await manager.disconnect('socket-o')

    const pausedMove = await manager.playMove(
      {
        commandId: randomUUID(),
        roomCode: host.identity.roomCode,
        sessionToken: host.identity.sessionToken,
        revision: guest.snapshot.revision + 1,
        index: 0,
      },
      'socket-x',
    )
    expect(pausedMove).toMatchObject({
      ok: false,
      error: { code: 'OPPONENT_OFFLINE' },
    })

    const resumed = expectJoined(
      await manager.resumeRoom(
        host.identity.roomCode,
        guest.identity.sessionToken,
        'socket-o-new',
      ),
    )
    const afterX = await expectCommandSucceeded(
      manager.playMove(
        {
          commandId: randomUUID(),
          roomCode: host.identity.roomCode,
          sessionToken: host.identity.sessionToken,
          revision: resumed.snapshot.revision,
          index: 0,
        },
        'socket-x',
      ),
    )

    expect(resumed.snapshot.players.O?.connected).toBe(true)
    expect(afterX.match.round.board[0]).toBe('X')

    manager.dispose()
  })

  it('starts the next round only after both players are ready', async () => {
    const manager = new RoomManager()
    const host = await createRoom(manager)
    const guest = await joinRoom(manager, host)
    let snapshot = guest.snapshot

    for (const [socketId, token, index] of [
      ['socket-x', host.identity.sessionToken, 0],
      ['socket-o', guest.identity.sessionToken, 3],
      ['socket-x', host.identity.sessionToken, 1],
      ['socket-o', guest.identity.sessionToken, 4],
      ['socket-x', host.identity.sessionToken, 2],
    ] as const) {
      const payload = {
        commandId: randomUUID(),
        roomCode: host.identity.roomCode,
        sessionToken: token,
        revision: snapshot.revision,
        index,
      }

      if (snapshot.match.round.moveCount === 4) {
        const [first, duplicate] = await Promise.all([
          manager.playMove(payload, socketId),
          manager.playMove(payload, socketId),
        ])
        expect(duplicate).toEqual(first)
        snapshot = await expectCommandSucceeded(first)
      } else {
        snapshot = await expectCommandSucceeded(
          manager.playMove(payload, socketId),
        )
      }
    }

    const hostReady = await expectCommandSucceeded(
      manager.readyForNextRound(
        {
          commandId: randomUUID(),
          roomCode: host.identity.roomCode,
          sessionToken: host.identity.sessionToken,
          revision: snapshot.revision,
        },
        'socket-x',
      ),
    )
    const nextRound = await expectCommandSucceeded(
      manager.readyForNextRound(
        {
          commandId: randomUUID(),
          roomCode: host.identity.roomCode,
          sessionToken: guest.identity.sessionToken,
          revision: hostReady.revision,
        },
        'socket-o',
      ),
    )

    expect(snapshot.match.round.status).toBe('won')
    expect(hostReady.readyForNextRound).toEqual(['X'])
    expect(nextRound.match.roundNumber).toBe(2)
    expect(nextRound.match.round.currentPlayer).toBe('O')

    manager.dispose()
  })

  it('updates public profiles and the all-time rivalry after a round', async () => {
    const completedRounds: {
      xProfileId: string
      oProfileId: string
      outcome: 'X' | 'O' | 'draw'
    }[] = []
    const profileX: PublicPlayerProfile = {
      id: '10000000-0000-4000-8000-000000000001',
      displayName: 'Alex',
      avatarKey: 'coral',
      record: { wins: 4, losses: 2, draws: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const profileO: PublicPlayerProfile = {
      id: '10000000-0000-4000-8000-000000000002',
      displayName: 'Sam',
      avatarKey: 'teal',
      record: { wins: 3, losses: 3, draws: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const manager = new RoomManager({
      onProfileRoundCompleted: (round) => completedRounds.push(round),
    })
    const host = await createRoom(manager, { profile: profileX })
    const guest = await joinRoom(manager, host, {
      profile: profileO,
      rivalry: { xWins: 2, oWins: 1, draws: 1 },
    })
    let snapshot = guest.snapshot

    for (const [socketId, token, index] of [
      ['socket-x', host.identity.sessionToken, 0],
      ['socket-o', guest.identity.sessionToken, 3],
      ['socket-x', host.identity.sessionToken, 1],
      ['socket-o', guest.identity.sessionToken, 4],
      ['socket-x', host.identity.sessionToken, 2],
    ] as const) {
      const payload = {
        commandId: randomUUID(),
        roomCode: host.identity.roomCode,
        sessionToken: token,
        revision: snapshot.revision,
        index,
      }

      if (snapshot.match.round.moveCount === 4) {
        const [first, duplicate] = await Promise.all([
          manager.playMove(payload, socketId),
          manager.playMove(payload, socketId),
        ])
        expect(duplicate).toEqual(first)
        snapshot = await expectCommandSucceeded(first)
      } else {
        snapshot = await expectCommandSucceeded(
          manager.playMove(payload, socketId),
        )
      }
    }

    expect(snapshot.players.X?.profile.record).toEqual({
      wins: 5,
      losses: 2,
      draws: 1,
    })
    expect(snapshot.players.O?.profile.record).toEqual({
      wins: 3,
      losses: 4,
      draws: 2,
    })
    expect(snapshot.rivalry).toEqual({ xWins: 3, oWins: 1, draws: 1 })
    expect(completedRounds).toEqual([
      {
        xProfileId: profileX.id,
        oProfileId: profileO.id,
        outcome: 'X',
      },
    ])

    manager.dispose()
  })

  it('restores active matches and command receipts after a restart', async () => {
    const roomStore = new InMemoryRoomStateStore()
    const firstManager = new RoomManager({
      disconnectGraceMs: 60_000,
      roomStore,
    })
    await firstManager.initialize()
    const host = await createRoom(firstManager)
    const guest = await joinRoom(firstManager, host)
    const movePayload = {
      commandId: randomUUID(),
      roomCode: host.identity.roomCode,
      sessionToken: host.identity.sessionToken,
      revision: guest.snapshot.revision,
      index: 0,
    }
    const moveResponse = await firstManager.playMove(
      movePayload,
      'socket-x',
    )
    await firstManager.close()

    const history: HistoryEventDraft[] = []
    const secondManager = new RoomManager({
      disconnectGraceMs: 60_000,
      onHistoryEvent: (event) => history.push(event),
      roomStore,
    })
    await secondManager.initialize()
    const restoredDirectory = await secondManager.getDirectory()
    const replayedMove = await secondManager.playMove(
      movePayload,
      'stale-socket',
    )
    const resumedHost = expectJoined(
      await secondManager.resumeRoom(
        host.identity.roomCode,
        host.identity.sessionToken,
        'socket-x-restored',
        randomUUID(),
      ),
    )
    const resumedGuest = expectJoined(
      await secondManager.resumeRoom(
        guest.identity.roomCode,
        guest.identity.sessionToken,
        'socket-o-restored',
        randomUUID(),
      ),
    )

    expect(restoredDirectory.rooms).toMatchObject([
      {
        roomCode: host.identity.roomCode,
        hostConnected: false,
        playerCount: 2,
      },
    ])
    expect(replayedMove).toEqual(moveResponse)
    expect(resumedHost.snapshot.players.X?.connected).toBe(true)
    expect(resumedHost.snapshot.players.O?.connected).toBe(false)
    expect(resumedGuest.snapshot.match.round.board[0]).toBe('X')
    expect(history).toContainEqual(
      expect.objectContaining({
        type: 'room_recovered',
      }),
    )

    await secondManager.close()
  })

  it('restores private-room password verification after a restart', async () => {
    const roomStore = new InMemoryRoomStateStore()
    const firstManager = new RoomManager({ roomStore })
    await firstManager.initialize()
    const host = await createRoom(firstManager, {
      roomName: 'Durable private table',
      visibility: 'private',
      password: 'correct-horse',
    })
    await firstManager.close()

    const secondManager = new RoomManager({ roomStore })
    await secondManager.initialize()
    await secondManager.resumeRoom(
      host.identity.roomCode,
      host.identity.sessionToken,
      'socket-x-restored',
      randomUUID(),
    )
    const rejected = await secondManager.joinRoom(
      host.identity.roomCode,
      'Sam',
      'wrong-password',
      'socket-o-wrong',
      undefined,
      undefined,
      randomUUID(),
    )
    const joined = await secondManager.joinRoom(
      host.identity.roomCode,
      'Sam',
      'correct-horse',
      'socket-o',
      undefined,
      undefined,
      randomUUID(),
    )

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PASSWORD' },
    })
    expect(joined).toMatchObject({
      ok: true,
      snapshot: {
        roomName: 'Durable private table',
        visibility: 'private',
      },
    })

    await secondManager.close()
  })

  it('expires a disconnected guest seat after the grace period', async () => {
    vi.useFakeTimers()
    const snapshots: RoomSnapshot[] = []
    const manager = new RoomManager({
      disconnectGraceMs: 1_000,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    })
    const host = await createRoom(manager)
    await joinRoom(manager, host)

    await manager.disconnect('socket-o')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(snapshots.at(-1)?.players.O).toBeNull()
    expect((await manager.getDirectory()).rooms[0]?.playerCount).toBe(1)

    manager.dispose()
  })

  it('publishes one directory delta when several rooms expire together', async () => {
    let now = 0
    const deltas: RoomDirectoryDelta[] = []
    const manager = new RoomManager({
      now: () => now,
      roomTtlMs: 1_000,
      onDirectoryDelta: (delta) => deltas.push(delta),
    })

    await createRoom(manager, { socketId: 'socket-x-1' })
    await createRoom(manager, { socketId: 'socket-x-2' })
    now = 1_001

    expect((await manager.getDirectory()).rooms).toEqual([])
    expect(deltas.map((delta) => delta.revision)).toEqual([1, 2, 3])
    expect(deltas.at(-1)).toMatchObject({
      upserts: [],
      removedRoomCodes: expect.arrayContaining([
        expect.any(String),
        expect.any(String),
      ]),
    })

    manager.dispose()
  })
})
