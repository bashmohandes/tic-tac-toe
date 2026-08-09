// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  io as createClient,
  type Socket as ClientSocket,
} from 'socket.io-client'
import type {
  ClientToServerEvents,
  JoinRoomResponse,
  PlayerAvatarKey,
  PlayerProfileSession,
  ProfileCredentials,
  RoomClosedEvent,
  RoomCommandResponse,
  RoomDirectoryResponse,
  RoomSnapshot,
  ServerToClientEvents,
} from '../src/game/protocol'
import {
  createGameServer,
  type GameServer,
} from './game-server'

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>

function connectClient(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const client: TestClient = createClient(url, {
      autoConnect: false,
      forceNew: true,
      transports: ['websocket'],
    })

    client.once('connect', () => resolve(client))
    client.once('connect_error', reject)
    client.connect()
  })
}

function createRoom(
  client: TestClient,
  name: string,
  options: {
    readonly roomName?: string
    readonly visibility?: 'public' | 'private'
    readonly password?: string
    readonly profile?: ProfileCredentials
  } = {},
): Promise<JoinRoomResponse> {
  return new Promise((resolve) => {
    client.emit(
      'room:create',
      {
        commandId: randomUUID(),
        name,
        roomName: options.roomName ?? 'Friday game',
        visibility: options.visibility ?? 'public',
        password: options.password,
        profile: options.profile,
      },
      resolve,
    )
  })
}

function joinRoom(
  client: TestClient,
  name: string,
  roomCode: string,
  password?: string,
  profile?: ProfileCredentials,
): Promise<JoinRoomResponse> {
  return new Promise((resolve) => {
    client.emit(
      'room:join',
      {
        commandId: randomUUID(),
        name,
        roomCode,
        password,
        profile,
      },
      resolve,
    )
  })
}

async function createProfile(
  baseUrl: string,
  displayName: string,
  avatarKey: PlayerAvatarKey,
): Promise<PlayerProfileSession> {
  const response = await fetch(`${baseUrl}/api/profiles/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName, avatarKey }),
  })
  const body = (await response.json()) as {
    ok: boolean
    session?: PlayerProfileSession
  }

  if (!response.ok || !body.ok || !body.session) {
    throw new Error('Profile creation failed')
  }

  return body.session
}

function listRooms(
  client: TestClient,
): Promise<RoomDirectoryResponse> {
  return new Promise((resolve) => {
    client.emit('rooms:list', resolve)
  })
}

function playMove(
  client: TestClient,
  payload: Omit<
    Parameters<ClientToServerEvents['game:play']>[0],
    'commandId'
  >,
): Promise<RoomCommandResponse> {
  return new Promise((resolve) => {
    client.emit(
      'game:play',
      { ...payload, commandId: randomUUID() },
      resolve,
    )
  })
}

function waitForSnapshot(client: TestClient): Promise<RoomSnapshot> {
  return new Promise((resolve) => {
    client.once('room:snapshot', resolve)
  })
}

function waitForRoomClosed(client: TestClient): Promise<RoomClosedEvent> {
  return new Promise((resolve) => {
    client.once('room:closed', resolve)
  })
}

describe('Socket.IO game server', () => {
  let server: GameServer
  let baseUrl: string
  const clients: TestClient[] = []

  beforeEach(async () => {
    server = createGameServer({ disconnectGraceMs: 2_000 })
    const address = await server.listen(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    for (const client of clients) {
      client.disconnect()
    }
    clients.length = 0
    await server.close()
  })

  it('serves health status and synchronizes two authoritative clients', async () => {
    const healthResponse = await fetch(`${baseUrl}/health`)
    const health = (await healthResponse.json()) as {
      status: string
      rooms: number
      roomState: {
        backend: string
        status: string
      }
    }
    expect(healthResponse.status).toBe(200)
    expect(health).toMatchObject({
      status: 'ok',
      rooms: 0,
      roomState: {
        backend: 'memory',
        status: 'ready',
      },
    })

    const hostClient = await connectClient(baseUrl)
    const guestClient = await connectClient(baseUrl)
    clients.push(hostClient, guestClient)

    const host = await createRoom(hostClient, 'Alex')
    expect(host.ok).toBe(true)
    if (!host.ok) {
      throw new Error(host.error.message)
    }
    expect(await listRooms(guestClient)).toMatchObject({
      rooms: [
        {
          roomCode: host.identity.roomCode,
          roomName: 'Friday game',
          visibility: 'public',
          playerCount: 1,
        },
      ],
    })

    const hostUpdate = waitForSnapshot(hostClient)
    const guest = await joinRoom(guestClient, 'Sam', host.identity.roomCode)
    expect(guest.ok).toBe(true)
    if (!guest.ok) {
      throw new Error(guest.error.message)
    }

    expect((await hostUpdate).players.O?.name).toBe('Sam')

    const illegalMove = await playMove(guestClient, {
      roomCode: guest.identity.roomCode,
      sessionToken: guest.identity.sessionToken,
      revision: guest.snapshot.revision,
      index: 0,
    })
    expect(illegalMove).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_TURN' },
    })

    const guestUpdate = waitForSnapshot(guestClient)
    const validMove = await playMove(hostClient, {
      roomCode: host.identity.roomCode,
      sessionToken: host.identity.sessionToken,
      revision: guest.snapshot.revision,
      index: 0,
    })
    expect(validMove).toMatchObject({ ok: true })
    expect((await guestUpdate).match.round.board[0]).toBe('X')

    const roomClosed = waitForRoomClosed(guestClient)
    await new Promise<RoomCommandResponse>((resolve) => {
      hostClient.emit(
        'room:leave',
        {
          commandId: randomUUID(),
          roomCode: host.identity.roomCode,
          sessionToken: host.identity.sessionToken,
        },
        resolve,
      )
    })
    expect(await roomClosed).toMatchObject({
      roomCode: host.identity.roomCode,
    })
  })

  it('limits profile creation without blocking profile refreshes', async () => {
    await server.close()
    server = createGameServer({
      disconnectGraceMs: 2_000,
      profileCreationRateLimit: {
        maxRequests: 2,
        windowMs: 60_000,
      },
    })
    const address = await server.listen(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${address.port}`

    const first = await createProfile(baseUrl, 'Alex', 'coral')
    await createProfile(baseUrl, 'Sam', 'teal')
    const limitedResponse = await fetch(
      `${baseUrl}/api/profiles/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Jordan',
          avatarKey: 'gold',
        }),
      },
    )
    const limited = (await limitedResponse.json()) as {
      readonly code?: string
      readonly error?: string
      readonly ok: boolean
    }
    const refreshResponse = await fetch(
      `${baseUrl}/api/profiles/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: first.credentials }),
      },
    )

    expect(limitedResponse.status).toBe(429)
    expect(limitedResponse.headers.get('retry-after')).toBe('60')
    expect(limited).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
    })
    expect(refreshResponse.status).toBe(200)
  })

  it('restores a disconnected player with its private session token', async () => {
    const hostClient = await connectClient(baseUrl)
    const firstGuestClient = await connectClient(baseUrl)
    clients.push(hostClient, firstGuestClient)

    const host = await createRoom(hostClient, 'Alex')
    if (!host.ok) {
      throw new Error(host.error.message)
    }
    const guest = await joinRoom(
      firstGuestClient,
      'Sam',
      host.identity.roomCode,
    )
    if (!guest.ok) {
      throw new Error(guest.error.message)
    }

    const offlineUpdate = waitForSnapshot(hostClient)
    firstGuestClient.disconnect()
    expect((await offlineUpdate).players.O?.connected).toBe(false)

    const resumedClient = await connectClient(baseUrl)
    clients.push(resumedClient)
    const resumed = await new Promise<JoinRoomResponse>((resolve) => {
      resumedClient.emit(
        'room:resume',
        {
          commandId: randomUUID(),
          roomCode: guest.identity.roomCode,
          sessionToken: guest.identity.sessionToken,
        },
        resolve,
      )
    })

    expect(resumed).toMatchObject({
      ok: true,
      identity: { player: 'O', name: 'Sam' },
      snapshot: {
        players: {
          O: { connected: true },
        },
      },
    })
  })

  it('requires the correct password for a listed private room', async () => {
    const hostClient = await connectClient(baseUrl)
    const guestClient = await connectClient(baseUrl)
    clients.push(hostClient, guestClient)

    const host = await createRoom(hostClient, 'Alex', {
      roomName: 'Locked table',
      visibility: 'private',
      password: 'correct-horse',
    })
    if (!host.ok) {
      throw new Error(host.error.message)
    }

    const directory = await listRooms(guestClient)
    expect(directory.rooms[0]).toMatchObject({
      roomName: 'Locked table',
      visibility: 'private',
      hostName: 'Alex',
    })
    expect(JSON.stringify(directory)).not.toContain('correct-horse')

    const rejected = await joinRoom(
      guestClient,
      'Sam',
      host.identity.roomCode,
      'wrong-password',
    )
    const joined = await joinRoom(
      guestClient,
      'Sam',
      host.identity.roomCode,
      'correct-horse',
    )

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PASSWORD' },
    })
    expect(joined).toMatchObject({
      ok: true,
      snapshot: {
        roomName: 'Locked table',
        visibility: 'private',
      },
    })
  })

  it('shows durable profiles and updates the rivalry after a round', async () => {
    const alexProfile = await createProfile(baseUrl, 'Alex', 'coral')
    const samProfile = await createProfile(baseUrl, 'Sam', 'teal')
    const hostClient = await connectClient(baseUrl)
    const guestClient = await connectClient(baseUrl)
    clients.push(hostClient, guestClient)
    const host = await createRoom(hostClient, 'Alex', {
      roomName: 'Rivals table',
      profile: alexProfile.credentials,
    })
    if (!host.ok) {
      throw new Error(host.error.message)
    }
    const directory = await listRooms(guestClient)
    expect(directory.rooms[0]?.hostProfile).toMatchObject({
      id: alexProfile.profile.id,
      displayName: 'Alex',
      avatarKey: 'coral',
      record: { wins: 0, losses: 0, draws: 0 },
    })

    const guest = await joinRoom(
      guestClient,
      'Sam',
      host.identity.roomCode,
      undefined,
      samProfile.credentials,
    )
    if (!guest.ok) {
      throw new Error(guest.error.message)
    }

    let snapshot = guest.snapshot
    for (const [client, identity, index] of [
      [hostClient, host.identity, 0],
      [guestClient, guest.identity, 3],
      [hostClient, host.identity, 1],
      [guestClient, guest.identity, 4],
      [hostClient, host.identity, 2],
    ] as const) {
      const response = await playMove(client, {
        roomCode: identity.roomCode,
        sessionToken: identity.sessionToken,
        revision: snapshot.revision,
        index,
      })

      if (!response.ok || !response.snapshot) {
        throw new Error(
          response.ok ? 'Missing snapshot' : response.error.message,
        )
      }
      snapshot = response.snapshot
    }

    expect(snapshot.players.X?.profile.record).toMatchObject({
      wins: 1,
      losses: 0,
      draws: 0,
    })
    expect(snapshot.players.O?.profile.record).toMatchObject({
      wins: 0,
      losses: 1,
      draws: 0,
    })
    expect(snapshot.rivalry).toEqual({ xWins: 1, oWins: 0, draws: 0 })

    const refreshedResponse = await fetch(
      `${baseUrl}/api/profiles/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credentials: alexProfile.credentials,
        }),
      },
    )
    const refreshed = (await refreshedResponse.json()) as {
      session: PlayerProfileSession
    }
    expect(refreshed.session.profile.record.wins).toBe(1)
  })

  it('protects durable history and omits room credentials', async () => {
    await server.close()
    server = createGameServer({
      adminApiKey: 'operator-test-key',
      disconnectGraceMs: 2_000,
    })
    const address = await server.listen(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${address.port}`

    const hostClient = await connectClient(baseUrl)
    const guestClient = await connectClient(baseUrl)
    clients.push(hostClient, guestClient)
    const host = await createRoom(hostClient, 'Alex', {
      roomName: 'Audit table',
      visibility: 'private',
      password: 'correct-horse',
    })
    if (!host.ok) {
      throw new Error(host.error.message)
    }
    await joinRoom(
      guestClient,
      'Sam',
      host.identity.roomCode,
      'correct-horse',
    )

    const unauthorized = await fetch(
      `${baseUrl}/api/admin/history/events`,
    )
    const authorized = await fetch(
      `${baseUrl}/api/admin/history/events?hours=24&limit=100`,
      {
        headers: {
          'x-admin-api-key': 'operator-test-key',
        },
      },
    )
    const body = (await authorized.json()) as {
      events: readonly { type: string }[]
    }
    const serialized = JSON.stringify(body)

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(200)
    expect(body.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'service_started',
        'room_created',
        'match_started',
      ]),
    )
    expect(serialized).not.toContain('correct-horse')
    expect(serialized).not.toContain(host.identity.roomCode)
    expect(serialized).not.toContain(host.identity.sessionToken)
  })
})
