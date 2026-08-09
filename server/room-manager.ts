import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import type { HistoryEventDraft } from '../src/history'
import {
  createMatchState,
  matchReducer,
  type MatchState,
} from '../src/game/match'
import type { Player } from '../src/game/engine'
import {
  PROTOCOL_VERSION,
  type JoinRoomResponse,
  type LeaveRoomPayload,
  type PlayMovePayload,
  type RoomCommandPayload,
  type RoomCommandResponse,
  type RoomDirectoryDelta,
  type RoomDirectoryEntry,
  type RoomError,
  type RoomDirectoryResponse,
  type PublicPlayerProfile,
  type RivalryRecord,
  type RoomSnapshot,
  type RoomVisibility,
  type SessionIdentity,
} from '../src/game/protocol'
import { InMemoryRoomStateStore } from './rooms/in-memory-store'
import {
  ROOM_STATE_SCHEMA_VERSION,
  type CachedCommandResponse,
  type CommandReceipt,
  type PersistedRoom,
  type RoomStateStore,
  type RoomStoreMutation,
} from './rooms/store'

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const DEFAULT_DISCONNECT_GRACE_MS = 60_000
const DEFAULT_ROOM_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ROOMS = 10_000
const PASSWORD_KEY_LENGTH = 32
const COMMAND_RECEIPT_TTL_MS = 10 * 60_000
const scryptAsync = promisify(scrypt)

interface PasswordRecord {
  readonly salt: Buffer
  readonly hash: Buffer
}

interface RoomPlayer {
  readonly id: string
  readonly mark: Player
  readonly name: string
  profile: PublicPlayerProfile
  readonly persistentProfile: boolean
  readonly sessionToken: string
  socketId: string | null
  connected: boolean
  disconnectExpiresAt: number | null
  disconnectTimer: ReturnType<typeof setTimeout> | null
}

interface Room {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly visibility: RoomVisibility
  readonly password: PasswordRecord | null
  matchId: string | null
  match: MatchState
  rivalry: RivalryRecord | null
  revision: number
  readonly players: {
    X: RoomPlayer
    O?: RoomPlayer
  }
  readonly readyForNextRound: Set<Player>
  lastActivityAt: number
}

interface AuthorizedPlayer {
  readonly room: Room
  readonly player: RoomPlayer
}

export interface CompletedProfileRound {
  readonly xProfileId: string
  readonly oProfileId: string
  readonly outcome: 'X' | 'O' | 'draw'
}

export interface RoomManagerOptions {
  readonly disconnectGraceMs?: number
  readonly roomTtlMs?: number
  readonly now?: () => number
  readonly onSnapshot?: (snapshot: RoomSnapshot) => void
  readonly onRoomClosed?: (roomCode: string, reason: string) => void
  readonly onDirectoryDelta?: (delta: RoomDirectoryDelta) => void
  readonly onHistoryEvent?: (event: HistoryEventDraft) => void
  readonly onProfileRoundCompleted?: (round: CompletedProfileRound) => void
  readonly roomStore?: RoomStateStore
}

function roomError(code: RoomError['code'], message: string): RoomError {
  return { code, message }
}

function failedCommand(
  error: RoomError,
  snapshot?: RoomSnapshot,
): RoomCommandResponse {
  return {
    ok: false,
    error,
    ...(snapshot ? { snapshot } : {}),
  }
}

export class RoomManager {
  readonly backend: RoomStateStore['backend']
  private readonly rooms = new Map<string, Room>()
  private readonly socketIndex = new Map<
    string,
    { readonly roomCode: string; readonly player: Player }
  >()
  private readonly disconnectGraceMs: number
  private readonly roomTtlMs: number
  private readonly now: () => number
  private readonly onSnapshot: (snapshot: RoomSnapshot) => void
  private readonly onRoomClosed: (roomCode: string, reason: string) => void
  private readonly onDirectoryDelta: (delta: RoomDirectoryDelta) => void
  private readonly onHistoryEvent: (event: HistoryEventDraft) => void
  private readonly onProfileRoundCompleted: (
    round: CompletedProfileRound,
  ) => void
  private readonly roomStore: RoomStateStore
  private readonly commandReceipts = new Map<string, CommandReceipt>()
  private readonly commandLocks = new Map<string, Promise<void>>()
  private readonly persistenceQueues = new Map<string, Promise<void>>()
  private directoryRevision = 0
  private currentStatus: 'starting' | 'ready' | 'degraded' | 'closed' =
    'starting'
  private initialized = false
  private closed = false

  constructor(options: RoomManagerOptions = {}) {
    this.disconnectGraceMs =
      options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS
    this.roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS
    this.now = options.now ?? Date.now
    this.onSnapshot = options.onSnapshot ?? (() => undefined)
    this.onRoomClosed = options.onRoomClosed ?? (() => undefined)
    this.onDirectoryDelta =
      options.onDirectoryDelta ?? (() => undefined)
    this.onHistoryEvent = options.onHistoryEvent ?? (() => undefined)
    this.onProfileRoundCompleted =
      options.onProfileRoundCompleted ?? (() => undefined)
    this.roomStore = options.roomStore ?? new InMemoryRoomStateStore()
    this.backend = this.roomStore.backend
  }

  get roomCount(): number {
    return this.rooms.size
  }

  get status() {
    return this.currentStatus
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.roomStore.initialize()
    const storedRooms = await this.roomStore.loadActiveRooms(this.now())

    for (const stored of storedRooms) {
      const room = this.restoreRoom(stored)

      if (!room) {
        await this.persistMutation({ deleteRoomId: stored.id })
        continue
      }

      this.rooms.set(room.code, room)
      await this.persistMutation({ upsert: this.persistedRoom(room) })
      this.schedulePlayerExpirations(room)
      this.record({
        type: 'room_recovered',
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          playerCount: Object.values(room.players).filter(Boolean).length,
          revision: room.revision,
        },
      })
    }

    this.initialized = true
    this.currentStatus = 'ready'
  }

  getHostProfileId(roomCode: string): string | null {
    const host = this.rooms.get(roomCode)?.players.X
    return host?.persistentProfile ? host.id : null
  }

  async getDirectory(): Promise<RoomDirectoryResponse> {
    await this.removeExpiredRooms()

    return {
      rooms: this.buildDirectory(),
      revision: this.directoryRevision,
    }
  }

  private buildDirectory(): readonly RoomDirectoryEntry[] {
    return [...this.rooms.values()]
      .map((room) => this.directoryEntry(room))
      .sort(
        (first, second) =>
          first.roomName.localeCompare(second.roomName) ||
          first.roomCode.localeCompare(second.roomCode),
      )
  }

  private directoryEntry(room: Room): RoomDirectoryEntry {
    return {
      roomCode: room.code,
      roomName: room.name,
      visibility: room.visibility,
      hostName: room.players.X?.name ?? 'Host',
      hostProfile: structuredClone(
        room.players.X?.profile ?? this.transientProfile('Host', 'X'),
      ),
      hostConnected: room.players.X?.connected ?? false,
      playerCount: Object.values(room.players).filter(Boolean).length,
      capacity: 2,
    }
  }

  async createRoom(
    details: {
      readonly commandId: string
      readonly name: string
      readonly roomName: string
      readonly visibility: RoomVisibility
      readonly password?: string
      readonly profile?: PublicPlayerProfile
    },
    socketId: string,
  ): Promise<JoinRoomResponse> {
    await this.removeExpiredRooms()
    const commandKey = this.commandKey(
      'room:create',
      details.commandId,
      details.profile?.id ?? socketId,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached = await this.cachedCommand<JoinRoomResponse>(commandKey)

      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey)
      }

      if (this.socketIndex.has(socketId)) {
        return {
          ok: false,
          error: roomError(
            'ALREADY_IN_ROOM',
            'Leave the current room before creating another one.',
          ),
        }
      }

      const password =
        details.visibility === 'private' && details.password
          ? await this.hashPassword(details.password)
          : null

      await this.removeExpiredRooms()

      if (this.socketIndex.has(socketId)) {
        return {
          ok: false,
          error: roomError(
            'ALREADY_IN_ROOM',
            'Leave the current room before creating another one.',
          ),
        }
      }

      if (this.rooms.size >= MAX_ROOMS) {
        return {
          ok: false,
          error: roomError(
            'ROOM_CLOSED',
            'The server has reached its active-room limit.',
          ),
        }
      }

      const code = this.createRoomCode()
      const player = this.createPlayer(
        'X',
        details.name,
        socketId,
        details.profile,
      )
      const room: Room = {
        id: randomUUID(),
        code,
        name: details.roomName,
        visibility: details.visibility,
        password,
        matchId: null,
        match: createMatchState(),
        rivalry: null,
        revision: 1,
        players: { X: player },
        readyForNextRound: new Set(),
        lastActivityAt: this.now(),
      }

      this.rooms.set(code, room)
      this.socketIndex.set(socketId, { roomCode: code, player: 'X' })
      const response = this.joinSuccess(room, player)
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response),
      })
      this.record({
        type: 'room_created',
        roomId: room.id,
        payload: {
          roomName: room.name,
          visibility: room.visibility,
        },
      })
      this.recordPlayerEvent('player_joined', room, player)
      this.emitDirectoryDelta([room], [])

      return response
    } finally {
      releaseCommand()
    }
  }

  async joinRoom(
    roomCode: string,
    name: string,
    password: string | undefined,
    socketId: string,
    profile?: PublicPlayerProfile,
    rivalry?: RivalryRecord,
    commandId?: string,
  ): Promise<JoinRoomResponse> {
    await this.removeExpiredRooms()
    const room = this.rooms.get(roomCode)
    const commandKey = this.commandKey(
      'room:join',
      commandId ?? randomUUID(),
      profile?.id ?? socketId,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached = await this.cachedCommand<JoinRoomResponse>(commandKey)

      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey)
      }

    if (this.socketIndex.has(socketId)) {
      return this.rejectJoin(
        null,
        roomError(
          'ALREADY_IN_ROOM',
          'Leave the current room before joining another one.',
        ),
      )
    }

    if (!room) {
      return this.rejectJoin(
        null,
        roomError('ROOM_NOT_FOUND', 'That room does not exist.'),
      )
    }

    if (room.players.O) {
      return this.rejectJoin(
        room,
        roomError('ROOM_FULL', 'That room already has two players.'),
      )
    }

    if (!room.players.X?.connected) {
      return this.rejectJoin(
        room,
        roomError(
          'ROOM_UNAVAILABLE',
          'The host is reconnecting. Try again in a moment.',
        ),
      )
    }

    if (profile && room.players.X?.id === profile.id) {
      return this.rejectJoin(
        room,
        roomError(
          'PROFILE_IN_USE',
          'This player profile already occupies the host seat.',
        ),
      )
    }

    if (
      room.visibility === 'private' &&
      (!password ||
        !room.password ||
        !(await this.verifyPassword(password, room.password)))
    ) {
      return this.rejectJoin(
        room,
        roomError('INVALID_PASSWORD', 'That password is incorrect.'),
      )
    }

    if (this.rooms.get(roomCode) !== room) {
      return this.rejectJoin(
        null,
        roomError('ROOM_NOT_FOUND', 'That room does not exist.'),
      )
    }

    if (this.socketIndex.has(socketId)) {
      return this.rejectJoin(
        room,
        roomError(
          'ALREADY_IN_ROOM',
          'Leave the current room before joining another one.',
        ),
      )
    }

    if (room.players.O) {
      return this.rejectJoin(
        room,
        roomError('ROOM_FULL', 'That room already has two players.'),
      )
    }

    if (!room.players.X?.connected) {
      return this.rejectJoin(
        room,
        roomError(
          'ROOM_UNAVAILABLE',
          'The host is reconnecting. Try again in a moment.',
        ),
      )
    }

    if (profile && room.players.X?.id === profile.id) {
      return this.rejectJoin(
        room,
        roomError(
          'PROFILE_IN_USE',
          'This player profile already occupies the host seat.',
        ),
      )
    }

    const player = this.createPlayer('O', name, socketId, profile)
    room.players.O = player
    room.matchId = randomUUID()
    room.match = createMatchState()
    room.rivalry = rivalry ?? { xWins: 0, oWins: 0, draws: 0 }
    room.readyForNextRound.clear()
    room.revision += 1
    this.touch(room)
    this.socketIndex.set(socketId, { roomCode, player: 'O' })
    const response = this.joinSuccess(room, player)
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.recordPlayerEvent('player_joined', room, player)
    this.record({
      type: 'match_started',
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        roundNumber: room.match.roundNumber,
        startingPlayer: room.match.round.startingPlayer,
        players: [
          this.playerHistory(room.players.X),
          this.playerHistory(player),
        ],
      },
    })
    this.emitSnapshot(room)
    this.emitDirectoryDelta([room], [])

      return response
    } finally {
      releaseCommand()
    }
  }

  async resumeRoom(
    roomCode: string,
    sessionToken: string,
    socketId: string,
    commandId: string = randomUUID(),
  ): Promise<JoinRoomResponse> {
    await this.removeExpiredRooms()
    const commandKey = this.commandKey(
      'room:resume',
      commandId,
      sessionToken,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached = await this.cachedCommand<JoinRoomResponse>(commandKey)

      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey)
      }

    const room = this.rooms.get(roomCode)

    if (!room) {
      return {
        ok: false,
        error: roomError('ROOM_NOT_FOUND', 'That room is no longer active.'),
      }
    }

    const player = this.findPlayerByToken(room, sessionToken)

    if (!player) {
      return {
        ok: false,
        error: roomError(
          'SESSION_INVALID',
          'This browser cannot resume that seat.',
        ),
      }
    }

    if (player.connected && player.socketId === socketId) {
      const response = this.joinSuccess(room, player)
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response),
      })
      return response
    }

    if (player.socketId) {
      this.socketIndex.delete(player.socketId)
    }
    this.clearPlayerTimer(player)
    player.socketId = socketId
    player.connected = true
    player.disconnectExpiresAt = null
    room.revision += 1
    this.touch(room)
    this.socketIndex.set(socketId, {
      roomCode,
      player: player.mark,
    })
    const response = this.joinSuccess(room, player)
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.recordPlayerEvent('player_reconnected', room, player)
    this.emitSnapshot(room)
    this.emitDirectoryDelta([room], [])

      return response
    } finally {
      releaseCommand()
    }
  }

  async playMove(
    payload: PlayMovePayload,
    socketId: string,
  ): Promise<RoomCommandResponse> {
    const commandKey = this.commandKey(
      'game:play',
      payload.commandId,
      payload.sessionToken,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached =
        await this.cachedCommand<RoomCommandResponse>(commandKey)

      if (cached) {
        return cached
      }

    const authorized = this.authorize(payload, socketId)

    if (!authorized.ok) {
      return authorized.response
    }

    const { player, room } = authorized.value
    const snapshot = this.snapshot(room)

    if (!this.hasTwoConnectedPlayers(room)) {
      return failedCommand(
        roomError(
          'OPPONENT_OFFLINE',
          'Play resumes when both players are connected.',
        ),
        snapshot,
      )
    }

    if (room.match.round.currentPlayer !== player.mark) {
      return failedCommand(
        roomError('NOT_YOUR_TURN', 'Wait for your turn.'),
        snapshot,
      )
    }

    const match = matchReducer(room.match, {
      type: 'play',
      index: payload.index,
    })

    if (match === room.match) {
      return failedCommand(
        roomError('INVALID_MOVE', 'That square is not available.'),
        snapshot,
      )
    }

    room.match = match
    room.readyForNextRound.clear()
    room.revision += 1
    this.touch(room)
    this.record({
      type: 'move_played',
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        index: payload.index,
        mark: player.mark,
        moveNumber: match.round.moveCount,
        playerId: player.id,
        roundNumber: match.roundNumber,
      },
    })

    const roundCompleted =
      snapshot.match.round.status === 'playing' &&
      match.round.status !== 'playing'

    if (roundCompleted) {
      const outcome =
        match.round.status === 'draw'
          ? 'draw'
          : (match.round.winner ?? 'draw')
      this.applyProfileRound(room, outcome)
      this.record({
        type: 'round_completed',
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          moveCount: match.round.moveCount,
          outcome,
          profileIds: {
            X: room.players.X?.id ?? null,
            O: room.players.O?.id ?? null,
          },
          rivalry: room.rivalry
            ? {
                xWins: room.rivalry.xWins,
                oWins: room.rivalry.oWins,
                draws: room.rivalry.draws,
              }
            : null,
          roundNumber: match.roundNumber,
          scores: {
            X: match.scores.X,
            O: match.scores.O,
            draws: match.scores.draws,
          },
          winningLine: match.round.winningLine ?? [],
        },
      })
    }

    const nextSnapshot = this.snapshot(room)
    const response: RoomCommandResponse = {
      ok: true,
      snapshot: nextSnapshot,
    }
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.onSnapshot(nextSnapshot)

    if (roundCompleted) {
      this.emitDirectoryDelta([room], [])
    }

      return response
    } finally {
      releaseCommand()
    }
  }

  async readyForNextRound(
    payload: RoomCommandPayload,
    socketId: string,
  ): Promise<RoomCommandResponse> {
    const commandKey = this.commandKey(
      'game:ready-next',
      payload.commandId,
      payload.sessionToken,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached =
        await this.cachedCommand<RoomCommandResponse>(commandKey)

      if (cached) {
        return cached
      }

    const authorized = this.authorize(payload, socketId)

    if (!authorized.ok) {
      return authorized.response
    }

    const { player, room } = authorized.value
    const snapshot = this.snapshot(room)

    if (!this.hasTwoConnectedPlayers(room)) {
      return failedCommand(
        roomError(
          'OPPONENT_OFFLINE',
          'Both players must reconnect before the next round.',
        ),
        snapshot,
      )
    }

    if (room.match.round.status === 'playing') {
      return failedCommand(
        roomError('ROUND_NOT_COMPLETE', 'Finish this round first.'),
        snapshot,
      )
    }

    room.readyForNextRound.add(player.mark)

    if (room.readyForNextRound.size === 2) {
      room.match = matchReducer(room.match, { type: 'next-round' })
      room.readyForNextRound.clear()
      this.record({
        type: 'round_started',
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          roundNumber: room.match.roundNumber,
          startingPlayer: room.match.round.startingPlayer,
        },
      })
    }

    room.revision += 1
    this.touch(room)
    const nextSnapshot = this.snapshot(room)
    const response: RoomCommandResponse = {
      ok: true,
      snapshot: nextSnapshot,
    }
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.onSnapshot(nextSnapshot)

      return response
    } finally {
      releaseCommand()
    }
  }

  async leaveRoom(
    payload: LeaveRoomPayload,
    socketId: string,
  ): Promise<RoomCommandResponse> {
    const commandKey = this.commandKey(
      'room:leave',
      payload.commandId,
      payload.sessionToken,
    )
    const releaseCommand = await this.acquireCommandLock(commandKey)

    try {
      const cached =
        await this.cachedCommand<RoomCommandResponse>(commandKey)

      if (cached) {
        return cached
      }

    const authorized = this.authorizeWithoutRevision(payload, socketId)

    if (!authorized.ok) {
      return authorized.response
    }

    const { player, room } = authorized.value
    this.socketIndex.delete(socketId)
    this.clearPlayerTimer(player)
    this.recordPlayerEvent('player_left', room, player, {
      reason: 'left',
    })

    if (player.mark === 'X') {
      const response: RoomCommandResponse = {
        ok: true,
        snapshot: null,
      }
      await this.closeRoom(
        room,
        'The room host ended the match.',
        'host_left',
        true,
        this.commandReceipt(commandKey, response),
      )
      return response
    }

    this.endMatch(room, 'guest_left')
    delete room.players.O
    room.match = createMatchState()
    room.rivalry = null
    room.readyForNextRound.clear()
    room.revision += 1
    this.touch(room)
    const snapshot = this.snapshot(room)
    const response: RoomCommandResponse = { ok: true, snapshot }
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.onSnapshot(snapshot)
    this.emitDirectoryDelta([room], [])

      return response
    } finally {
      releaseCommand()
    }
  }

  async disconnect(socketId: string): Promise<void> {
    const indexedPlayer = this.socketIndex.get(socketId)

    if (!indexedPlayer) {
      return
    }

    this.socketIndex.delete(socketId)
    const room = this.rooms.get(indexedPlayer.roomCode)
    const player = room?.players[indexedPlayer.player]

    if (!room || !player || player.socketId !== socketId) {
      return
    }

    player.socketId = null
    player.connected = false
    player.disconnectExpiresAt = this.now() + this.disconnectGraceMs
    room.readyForNextRound.delete(player.mark)
    room.revision += 1
    this.touch(room)
    await this.persistMutation({ upsert: this.persistedRoom(room) })
    this.recordPlayerEvent('player_disconnected', room, player)
    this.emitSnapshot(room)
    this.emitDirectoryDelta([room], [])

    player.disconnectTimer = setTimeout(() => {
      void this.expireDisconnectedPlayer(
        room.code,
        player.mark,
        player.sessionToken,
      )
    }, this.disconnectGraceMs)
    player.disconnectTimer.unref?.()
  }

  dispose(): void {
    void this.close()
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    for (const room of this.rooms.values()) {
      for (const player of Object.values(room.players)) {
        if (player) {
          this.clearPlayerTimer(player)
        }
      }
    }

    await Promise.allSettled([...this.commandLocks.values()])
    await Promise.allSettled([...this.persistenceQueues.values()])

    this.rooms.clear()
    this.socketIndex.clear()
    this.currentStatus = 'closed'
    await this.roomStore.close()
  }

  private commandKey(
    type: string,
    commandId: string,
    actor: string,
  ): string {
    return createHash('sha256')
      .update(`${type}\0${commandId}\0${actor}`)
      .digest('hex')
  }

  private async acquireCommandLock(key: string): Promise<() => void> {
    const previous = this.commandLocks.get(key)
    let resolveCurrent: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })

    this.commandLocks.set(key, current)

    if (previous) {
      await previous
    }

    return () => {
      resolveCurrent()
      if (this.commandLocks.get(key) === current) {
        this.commandLocks.delete(key)
      }
    }
  }

  private async cachedCommand<Response extends CachedCommandResponse>(
    key: string,
  ): Promise<Response | null> {
    const now = this.now()
    const cached = this.commandReceipts.get(key)

    if (cached) {
      if (cached.expiresAt > now) {
        return structuredClone(cached.response) as Response
      }

      this.commandReceipts.delete(key)
    }

    try {
      const stored = await this.roomStore.findReceipt(key, now)

      if (!stored) {
        return null
      }

      const receipt = {
        key,
        response: stored,
        expiresAt: now + COMMAND_RECEIPT_TTL_MS,
      }
      this.commandReceipts.set(key, receipt)
      this.currentStatus = 'ready'
      return structuredClone(stored) as Response
    } catch (error) {
      this.currentStatus = 'degraded'
      console.error('Room command receipt lookup failed.', error)
      return null
    }
  }

  private commandReceipt(
    key: string,
    response: CachedCommandResponse,
  ): CommandReceipt {
    const receipt = {
      key,
      response: structuredClone(response),
      expiresAt: this.now() + COMMAND_RECEIPT_TTL_MS,
    }
    this.commandReceipts.set(key, receipt)
    return receipt
  }

  private async reconnectCachedJoin(
    cached: JoinRoomResponse,
    socketId: string,
    commandKey: string,
  ): Promise<JoinRoomResponse> {
    if (!cached.ok) {
      return cached
    }

    const room = this.rooms.get(cached.identity.roomCode)
    const player = room
      ? this.findPlayerByToken(room, cached.identity.sessionToken)
      : null

    if (!room || !player) {
      return {
        ok: false,
        error: roomError(
          'ROOM_NOT_FOUND',
          'That room is no longer active.',
        ),
      }
    }

    if (player.connected && player.socketId === socketId) {
      return this.joinSuccess(room, player)
    }

    if (player.socketId) {
      this.socketIndex.delete(player.socketId)
    }
    this.clearPlayerTimer(player)
    player.socketId = socketId
    player.connected = true
    player.disconnectExpiresAt = null
    room.revision += 1
    this.touch(room)
    this.socketIndex.set(socketId, {
      roomCode: room.code,
      player: player.mark,
    })
    const response = this.joinSuccess(room, player)
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response),
    })
    this.recordPlayerEvent('player_reconnected', room, player)
    this.emitSnapshot(room)
    this.emitDirectoryDelta([room], [])
    return response
  }

  private async persistMutation(
    mutation: RoomStoreMutation,
  ): Promise<void> {
    const queueKey =
      mutation.upsert?.id ??
      mutation.deleteRoomId ??
      `receipt:${mutation.receipt?.key ?? randomUUID()}`
    const previous = this.persistenceQueues.get(queueKey)
    const commit = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.roomStore.commit(mutation))

    this.persistenceQueues.set(queueKey, commit)

    try {
      await commit
      if (!this.closed) {
        this.currentStatus = 'ready'
      }
    } catch (error) {
      this.currentStatus = 'degraded'
      console.error('Active room persistence failed.', error)
    } finally {
      if (this.persistenceQueues.get(queueKey) === commit) {
        this.persistenceQueues.delete(queueKey)
      }
    }
  }

  private persistedRoom(room: Room): PersistedRoom {
    const toPlayer = (player: RoomPlayer) => ({
      id: player.id,
      mark: player.mark,
      name: player.name,
      profile: structuredClone(player.profile),
      persistentProfile: player.persistentProfile,
      sessionToken: player.sessionToken,
      connected: player.connected,
      disconnectExpiresAt: player.disconnectExpiresAt,
    })

    return {
      schemaVersion: ROOM_STATE_SCHEMA_VERSION,
      id: room.id,
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      password: room.password
        ? {
            saltBase64: room.password.salt.toString('base64'),
            hashBase64: room.password.hash.toString('base64'),
          }
        : null,
      matchId: room.matchId,
      match: {
        round: {
          ...room.match.round,
          board: [...room.match.round.board],
          winningLine: room.match.round.winningLine
            ? [...room.match.round.winningLine]
            : null,
        },
        roundNumber: room.match.roundNumber,
        scores: { ...room.match.scores },
      },
      rivalry: room.rivalry ? { ...room.rivalry } : null,
      revision: room.revision,
      players: {
        X: toPlayer(room.players.X),
        ...(room.players.O ? { O: toPlayer(room.players.O) } : {}),
      },
      readyForNextRound: [...room.readyForNextRound],
      lastActivityAt: room.lastActivityAt,
      expiresAt: room.lastActivityAt + this.roomTtlMs,
    }
  }

  private restoreRoom(stored: PersistedRoom): Room | null {
    const now = this.now()
    const toPlayer = (
      player: PersistedRoom['players']['X'],
    ): RoomPlayer => {
      const disconnectExpiresAt = player.connected
        ? now + this.disconnectGraceMs
        : (player.disconnectExpiresAt ?? now + this.disconnectGraceMs)

      return {
        id: player.id,
        mark: player.mark,
        name: player.name,
        profile: structuredClone(player.profile),
        persistentProfile: player.persistentProfile,
        sessionToken: player.sessionToken,
        socketId: null,
        connected: false,
        disconnectExpiresAt,
        disconnectTimer: null,
      }
    }
    const playerX = toPlayer(stored.players.X)

    if (
      playerX.disconnectExpiresAt !== null &&
      playerX.disconnectExpiresAt <= now
    ) {
      return null
    }

    const playerO = stored.players.O ? toPlayer(stored.players.O) : null
    const guestExpired =
      playerO?.disconnectExpiresAt !== null &&
      playerO?.disconnectExpiresAt !== undefined &&
      playerO.disconnectExpiresAt <= now
    const room: Room = {
      id: stored.id,
      code: stored.code,
      name: stored.name,
      visibility: stored.visibility,
      password: stored.password
        ? {
            salt: Buffer.from(stored.password.saltBase64, 'base64'),
            hash: Buffer.from(stored.password.hashBase64, 'base64'),
          }
        : null,
      matchId: guestExpired ? null : stored.matchId,
      match: guestExpired
        ? createMatchState()
        : structuredClone(stored.match),
      rivalry: guestExpired
        ? null
        : stored.rivalry
          ? { ...stored.rivalry }
          : null,
      revision: stored.revision + 1,
      players: {
        X: playerX,
        ...(!guestExpired && playerO ? { O: playerO } : {}),
      },
      readyForNextRound: new Set(),
      lastActivityAt: stored.lastActivityAt,
    }

    return room
  }

  private schedulePlayerExpirations(room: Room): void {
    for (const player of Object.values(room.players)) {
      if (!player || player.connected || player.disconnectExpiresAt === null) {
        continue
      }

      const delay = Math.max(0, player.disconnectExpiresAt - this.now())
      player.disconnectTimer = setTimeout(() => {
        void this.expireDisconnectedPlayer(
          room.code,
          player.mark,
          player.sessionToken,
        )
      }, delay)
      player.disconnectTimer.unref?.()
    }
  }

  private createPlayer(
    mark: Player,
    name: string,
    socketId: string,
    profile?: PublicPlayerProfile,
  ): RoomPlayer {
    const playerProfile = profile ?? this.transientProfile(name, mark)

    return {
      id: playerProfile.id,
      mark,
      name: playerProfile.displayName,
      profile: structuredClone(playerProfile),
      persistentProfile: Boolean(profile),
      sessionToken: randomUUID(),
      socketId,
      connected: true,
      disconnectExpiresAt: null,
      disconnectTimer: null,
    }
  }

  private transientProfile(
    displayName: string,
    mark: Player,
  ): PublicPlayerProfile {
    return {
      id: randomUUID(),
      displayName,
      avatarKey: mark === 'X' ? 'coral' : 'teal',
      record: {
        wins: 0,
        losses: 0,
        draws: 0,
      },
      createdAt: new Date(this.now()).toISOString(),
    }
  }

  private async hashPassword(password: string): Promise<PasswordRecord> {
    const salt = randomBytes(16)
    const hash = (await scryptAsync(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
    )) as Buffer

    return { salt, hash }
  }

  private async verifyPassword(
    password: string,
    record: PasswordRecord,
  ): Promise<boolean> {
    const candidate = (await scryptAsync(
      password,
      record.salt,
      PASSWORD_KEY_LENGTH,
    )) as Buffer

    return (
      candidate.length === record.hash.length &&
      timingSafeEqual(candidate, record.hash)
    )
  }

  private createRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = ''

      for (let index = 0; index < 6; index += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]
      }

      if (!this.rooms.has(code)) {
        return code
      }
    }

    throw new Error('Unable to allocate a unique room code')
  }

  private authorize(
    payload: RoomCommandPayload,
    socketId: string,
  ):
    | { readonly ok: true; readonly value: AuthorizedPlayer }
    | { readonly ok: false; readonly response: RoomCommandResponse } {
    const authorized = this.authorizeWithoutRevision(payload, socketId)

    if (!authorized.ok) {
      return authorized
    }

    if (authorized.value.room.revision !== payload.revision) {
      return {
        ok: false,
        response: failedCommand(
          roomError(
            'STALE_STATE',
            'The room changed before that action arrived.',
          ),
          this.snapshot(authorized.value.room),
        ),
      }
    }

    return authorized
  }

  private authorizeWithoutRevision(
    payload: LeaveRoomPayload,
    socketId: string,
  ):
    | { readonly ok: true; readonly value: AuthorizedPlayer }
    | { readonly ok: false; readonly response: RoomCommandResponse } {
    const room = this.rooms.get(payload.roomCode)

    if (!room) {
      return {
        ok: false,
        response: failedCommand(
          roomError('ROOM_NOT_FOUND', 'That room is no longer active.'),
        ),
      }
    }

    const player = this.findPlayerByToken(room, payload.sessionToken)

    if (
      !player ||
      !player.connected ||
      player.socketId !== socketId
    ) {
      return {
        ok: false,
        response: failedCommand(
          roomError('SESSION_INVALID', 'Your room session is no longer valid.'),
          this.snapshot(room),
        ),
      }
    }

    return { ok: true, value: { room, player } }
  }

  private findPlayerByToken(
    room: Room,
    sessionToken: string,
  ): RoomPlayer | null {
    return (
      Object.values(room.players).find(
        (player) => player?.sessionToken === sessionToken,
      ) ?? null
    )
  }

  private hasTwoConnectedPlayers(room: Room): boolean {
    return Boolean(room.players.X?.connected && room.players.O?.connected)
  }

  private joinSuccess(room: Room, player: RoomPlayer): JoinRoomResponse {
    const identity: SessionIdentity = {
      roomCode: room.code,
      sessionToken: player.sessionToken,
      player: player.mark,
      name: player.name,
      profileId: player.id,
    }

    return {
      ok: true,
      identity,
      snapshot: this.snapshot(room),
    }
  }

  private snapshot(room: Room): RoomSnapshot {
    const toSnapshot = (
      player: RoomPlayer | undefined,
    ): RoomSnapshot['players'][Player] =>
      player
        ? {
            mark: player.mark,
            name: player.name,
            connected: player.connected,
            profile: structuredClone(player.profile),
          }
        : null

    return {
      protocolVersion: PROTOCOL_VERSION,
      roomCode: room.code,
      roomName: room.name,
      visibility: room.visibility,
      revision: room.revision,
      match: room.match,
      players: {
        X: toSnapshot(room.players.X),
        O: toSnapshot(room.players.O),
      },
      rivalry: room.rivalry ? { ...room.rivalry } : null,
      readyForNextRound: [...room.readyForNextRound],
    }
  }

  private emitSnapshot(room: Room): RoomSnapshot {
    const snapshot = this.snapshot(room)
    this.onSnapshot(snapshot)
    return snapshot
  }

  private emitDirectoryDelta(
    rooms: readonly Room[],
    removedRoomCodes: readonly string[],
  ): void {
    const uniqueRooms = new Map(
      rooms
        .filter((room) => this.rooms.get(room.code) === room)
        .map((room) => [room.code, room]),
    )
    const removed = [...new Set(removedRoomCodes)].filter(
      (roomCode) => !uniqueRooms.has(roomCode),
    )

    if (uniqueRooms.size === 0 && removed.length === 0) {
      return
    }

    this.directoryRevision += 1
    this.onDirectoryDelta({
      revision: this.directoryRevision,
      upserts: [...uniqueRooms.values()]
        .map((room) => this.directoryEntry(room))
        .sort(
          (first, second) =>
            first.roomName.localeCompare(second.roomName) ||
            first.roomCode.localeCompare(second.roomCode),
        ),
      removedRoomCodes: removed.sort(),
    })
  }

  private touch(room: Room): void {
    room.lastActivityAt = this.now()
  }

  private async expireDisconnectedPlayer(
    roomCode: string,
    mark: Player,
    sessionToken: string,
  ): Promise<void> {
    const room = this.rooms.get(roomCode)
    const player = room?.players[mark]

    if (
      !room ||
      !player ||
      player.connected ||
      player.sessionToken !== sessionToken
    ) {
      return
    }

    this.clearPlayerTimer(player)

    if (mark === 'X') {
      this.recordPlayerEvent('player_left', room, player, {
        reason: 'disconnect_timeout',
      })
      await this.closeRoom(
        room,
        'The room expired after the host disconnected.',
        'host_disconnect_timeout',
      )
      return
    }

    this.recordPlayerEvent('player_left', room, player, {
      reason: 'disconnect_timeout',
    })
    this.endMatch(room, 'guest_disconnect_timeout')
    delete room.players.O
    room.match = createMatchState()
    room.rivalry = null
    room.readyForNextRound.clear()
    room.revision += 1
    this.touch(room)
    await this.persistMutation({ upsert: this.persistedRoom(room) })
    this.emitSnapshot(room)
    this.emitDirectoryDelta([room], [])
  }

  private async closeRoom(
    room: Room,
    reason: string,
    historyReason: string,
    emitDirectory = true,
    receipt?: CommandReceipt,
  ): Promise<void> {
    this.endMatch(room, historyReason)

    for (const player of Object.values(room.players)) {
      if (player) {
        this.clearPlayerTimer(player)
        if (player.socketId) {
          this.socketIndex.delete(player.socketId)
        }
      }
    }

    this.rooms.delete(room.code)
    await this.persistMutation({
      deleteRoomId: room.id,
      ...(receipt ? { receipt } : {}),
    })
    this.record({
      type: 'room_closed',
      roomId: room.id,
      payload: { reason: historyReason },
    })
    this.onRoomClosed(room.code, reason)

    if (emitDirectory) {
      this.emitDirectoryDelta([], [room.code])
    }
  }

  private clearPlayerTimer(player: RoomPlayer): void {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer)
      player.disconnectTimer = null
    }
  }

  private async removeExpiredRooms(): Promise<void> {
    const cutoff = this.now() - this.roomTtlMs
    const removedRoomCodes: string[] = []

    for (const room of [...this.rooms.values()]) {
      if (room.lastActivityAt < cutoff) {
        await this.closeRoom(
          room,
          'The room expired after a period of inactivity.',
          'room_inactive',
          false,
        )
        removedRoomCodes.push(room.code)
      }
    }

    this.emitDirectoryDelta([], removedRoomCodes)
  }

  private rejectJoin(room: Room | null, error: RoomError): JoinRoomResponse {
    this.record({
      type: 'join_rejected',
      roomId: room?.id,
      matchId: room?.matchId,
      payload: { reason: error.code },
    })

    return { ok: false, error }
  }

  private playerHistory(player: RoomPlayer | undefined) {
    return player
      ? {
          id: player.id,
          mark: player.mark,
          name: player.name,
        }
      : null
  }

  private recordPlayerEvent(
    type:
      | 'player_joined'
      | 'player_disconnected'
      | 'player_reconnected'
      | 'player_left',
    room: Room,
    player: RoomPlayer,
    extra: Record<string, string> = {},
  ): void {
    this.record({
      type,
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        ...this.playerHistory(player),
        ...extra,
      },
    })
  }

  private applyProfileRound(
    room: Room,
    outcome: CompletedProfileRound['outcome'],
  ): void {
    const playerX = room.players.X
    const playerO = room.players.O

    if (!playerX || !playerO) {
      return
    }

    if (outcome === 'draw') {
      playerX.profile = this.incrementProfileRecord(playerX.profile, 'draws')
      playerO.profile = this.incrementProfileRecord(playerO.profile, 'draws')
    } else {
      const winner = outcome === 'X' ? playerX : playerO
      const loser = outcome === 'X' ? playerO : playerX
      winner.profile = this.incrementProfileRecord(winner.profile, 'wins')
      loser.profile = this.incrementProfileRecord(loser.profile, 'losses')
    }

    const rivalry = room.rivalry ?? {
      xWins: 0,
      oWins: 0,
      draws: 0,
    }
    room.rivalry = {
      xWins: rivalry.xWins + (outcome === 'X' ? 1 : 0),
      oWins: rivalry.oWins + (outcome === 'O' ? 1 : 0),
      draws: rivalry.draws + (outcome === 'draw' ? 1 : 0),
    }

    if (playerX.persistentProfile && playerO.persistentProfile) {
      this.onProfileRoundCompleted({
        xProfileId: playerX.id,
        oProfileId: playerO.id,
        outcome,
      })
    }
  }

  private incrementProfileRecord(
    profile: PublicPlayerProfile,
    field: keyof PublicPlayerProfile['record'],
  ): PublicPlayerProfile {
    return {
      ...profile,
      record: {
        ...profile.record,
        [field]: profile.record[field] + 1,
      },
    }
  }

  private endMatch(room: Room, reason: string): void {
    if (!room.matchId) {
      return
    }

    this.record({
      type: 'match_ended',
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        moveCount: room.match.round.moveCount,
        reason,
        roundNumber: room.match.roundNumber,
        roundStatus: room.match.round.status,
        scores: {
          X: room.match.scores.X,
          O: room.match.scores.O,
          draws: room.match.scores.draws,
        },
      },
    })
    room.matchId = null
  }

  private record(event: HistoryEventDraft): void {
    this.onHistoryEvent(event)
  }
}
