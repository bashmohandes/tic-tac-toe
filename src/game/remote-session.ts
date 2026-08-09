import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import {
  PROTOCOL_VERSION,
  commandIdSchema,
  playerProfileSessionSchema,
  sessionIdentitySchema,
  type ClientToServerEvents,
  type JoinRoomResponse,
  type PlayerAvatarKey,
  type PlayerProfileSession,
  type ProfileSessionResponse,
  type PublicPlayerProfile,
  type RoomCommandResponse,
  type RoomDirectoryDelta,
  type RoomDirectoryEntry,
  type RoomDirectoryResponse,
  type RoomSnapshot,
  type RoomVisibility,
  type ServerToClientEvents,
  type SessionIdentity,
} from './protocol'
import type { GameSession } from './session'

const SESSION_STORAGE_KEY = 'tic-tac-toe:online-session'
const PROFILE_STORAGE_KEY = 'tic-tac-toe:player-profile'
const PENDING_ENTRY_COMMAND_KEY = 'tic-tac-toe:pending-entry-command'
const COMMAND_TIMEOUT_MS = 6_000
const ENTRY_COMMAND_TTL_MS = 10 * 60_000

interface PendingEntryCommand {
  readonly commandId: string
  readonly expiresAt: number
  readonly operationKey: string
}

function compareRooms(
  first: RoomDirectoryEntry,
  second: RoomDirectoryEntry,
): number {
  return (
    first.roomName.localeCompare(second.roomName) ||
    first.roomCode.localeCompare(second.roomCode)
  )
}

export function applyRoomDirectoryDelta(
  rooms: readonly RoomDirectoryEntry[],
  delta: RoomDirectoryDelta,
): readonly RoomDirectoryEntry[] {
  const removed = new Set(delta.removedRoomCodes)
  const byCode = new Map(
    rooms
      .filter((room) => !removed.has(room.roomCode))
      .map((room) => [room.roomCode, room]),
  )

  for (const room of delta.upserts) {
    byCode.set(room.roomCode, room)
  }

  return [...byCode.values()].sort(compareRooms)
}

export function getRoomDirectoryDeltaAction(
  currentRevision: number | null,
  nextRevision: number,
): 'apply' | 'ignore' | 'refresh' {
  if (currentRevision === null || nextRevision > currentRevision + 1) {
    return 'refresh'
  }

  return nextRevision <= currentRevision ? 'ignore' : 'apply'
}

export type OnlineConnectionState =
  | 'disabled'
  | 'connecting'
  | 'lobby'
  | 'connected'
  | 'reconnecting'

export interface OnlineSessionController {
  readonly connectionState: OnlineConnectionState
  readonly error: string | null
  readonly gameSession: GameSession | null
  readonly identity: SessionIdentity | null
  readonly isSubmitting: boolean
  readonly profile: PublicPlayerProfile | null
  readonly rooms: readonly RoomDirectoryEntry[]
  readonly snapshot: RoomSnapshot | null
  readonly clearError: () => void
  readonly createRoom: (
    name: string,
    roomName: string,
    visibility: RoomVisibility,
    avatarKey: PlayerAvatarKey,
    password?: string,
  ) => void
  readonly joinRoom: (
    name: string,
    roomCode: string,
    avatarKey: PlayerAvatarKey,
    password?: string,
  ) => void
  readonly leaveRoom: () => void
  readonly refreshRooms: () => void
}

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>

function readStoredIdentity(): SessionIdentity | null {
  if (typeof window === 'undefined') {
    return null
  }

  const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY)

  if (!stored) {
    return null
  }

  try {
    const parsed = sessionIdentitySchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function storeIdentity(identity: SessionIdentity | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (identity) {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(identity),
    )
  } else {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY)
  }
}

function readPendingEntryCommand(): PendingEntryCommand | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const stored = window.sessionStorage.getItem(PENDING_ENTRY_COMMAND_KEY)

    if (!stored) {
      return null
    }

    const candidate = JSON.parse(stored) as Partial<PendingEntryCommand>
    const parsedCommandId = commandIdSchema.safeParse(candidate.commandId)

    if (
      !parsedCommandId.success ||
      typeof candidate.expiresAt !== 'number' ||
      candidate.expiresAt <= Date.now() ||
      typeof candidate.operationKey !== 'string'
    ) {
      window.sessionStorage.removeItem(PENDING_ENTRY_COMMAND_KEY)
      return null
    }

    return {
      commandId: parsedCommandId.data,
      expiresAt: candidate.expiresAt,
      operationKey: candidate.operationKey,
    }
  } catch {
    return null
  }
}

function storePendingEntryCommand(
  command: PendingEntryCommand | null,
): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (command) {
      window.sessionStorage.setItem(
        PENDING_ENTRY_COMMAND_KEY,
        JSON.stringify(command),
      )
    } else {
      window.sessionStorage.removeItem(PENDING_ENTRY_COMMAND_KEY)
    }
  } catch {
    // Some privacy modes disable session storage.
  }
}

function readStoredProfileSession(): PlayerProfileSession | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const stored = window.localStorage.getItem(PROFILE_STORAGE_KEY)

    if (!stored) {
      return null
    }

    const parsed = playerProfileSessionSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function storeProfileSession(session: PlayerProfileSession | null): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (session) {
      window.localStorage.setItem(
        PROFILE_STORAGE_KEY,
        JSON.stringify(session),
      )
    } else {
      window.localStorage.removeItem(PROFILE_STORAGE_KEY)
    }
  } catch {
    // Some privacy modes disable local storage.
  }
}

async function requestProfileSession(
  body: object,
): Promise<PlayerProfileSession> {
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    COMMAND_TIMEOUT_MS,
  )

  try {
    const response = await fetch('/api/profiles/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const result = (await response.json()) as ProfileSessionResponse

    if (!response.ok || !result.ok) {
      const error = new Error(
        result.ok ? 'Player profiles are unavailable.' : result.error,
      )
      error.name =
        !result.ok && result.code === 'INVALID_PROFILE'
          ? 'InvalidProfileError'
          : 'ProfileRequestError'
      throw error
    }

    const parsed = playerProfileSessionSchema.safeParse(result.session)

    if (!parsed.success) {
      throw new Error('The player profile response is invalid.')
    }

    return parsed.data
  } finally {
    window.clearTimeout(timeout)
  }
}

function updateRoomQuery(roomCode: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)

  if (roomCode) {
    url.searchParams.set('room', roomCode)
  } else {
    url.searchParams.delete('room')
  }

  window.history.replaceState({}, '', url)
}

export function hasStoredOnlineSession(): boolean {
  return readStoredIdentity() !== null
}

export function getRoomCodeFromUrl(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return (new URL(window.location.href).searchParams.get('room') ?? '')
    .trim()
    .toUpperCase()
}

export function useRemoteGameSession(enabled: boolean): OnlineSessionController {
  const [connectionState, setConnectionState] =
    useState<OnlineConnectionState>(enabled ? 'connecting' : 'disabled')
  const [identity, setIdentity] = useState<SessionIdentity | null>(() =>
    readStoredIdentity(),
  )
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [rooms, setRooms] = useState<readonly RoomDirectoryEntry[]>([])
  const [profileSession, setProfileSession] =
    useState<PlayerProfileSession | null>(readStoredProfileSession)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const socketRef = useRef<GameSocket | null>(null)
  const identityRef = useRef<SessionIdentity | null>(identity)
  const snapshotRef = useRef<RoomSnapshot | null>(snapshot)
  const profileSessionRef = useRef<PlayerProfileSession | null>(
    profileSession,
  )
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const directoryRevisionRef = useRef<number | null>(null)
  const directoryRefreshPendingRef = useRef(false)
  const directoryRefreshAgainRef = useRef(false)
  const pendingEntryCommandRef = useRef<PendingEntryCommand | null>(
    readPendingEntryCommand(),
  )

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
  }, [])

  const acceptDirectory = useCallback(
    (directory: RoomDirectoryResponse) => {
      const currentRevision = directoryRevisionRef.current

      if (
        currentRevision !== null &&
        directory.revision < currentRevision
      ) {
        return
      }

      directoryRevisionRef.current = directory.revision
      setRooms([...directory.rooms].sort(compareRooms))
    },
    [],
  )

  const requestDirectory = useCallback(
    (socket = socketRef.current) => {
      if (!socket?.connected) {
        return
      }

      if (directoryRefreshPendingRef.current) {
        directoryRefreshAgainRef.current = true
        return
      }

      directoryRefreshPendingRef.current = true
      socket.emit('rooms:list', (directory) => {
        if (socketRef.current !== socket) {
          return
        }

        directoryRefreshPendingRef.current = false
        acceptDirectory(directory)

        if (directoryRefreshAgainRef.current) {
          directoryRefreshAgainRef.current = false
          requestDirectory(socket)
        }
      })
    },
    [acceptDirectory],
  )

  const clearPendingEntryCommand = useCallback(() => {
    pendingEntryCommandRef.current = null
    storePendingEntryCommand(null)
  }, [])

  const entryCommandId = useCallback((operationKey: string): string => {
    const pending = pendingEntryCommandRef.current

    if (
      pending &&
      pending.expiresAt > Date.now() &&
      pending.operationKey === operationKey
    ) {
      return pending.commandId
    }

    const next = {
      commandId: globalThis.crypto.randomUUID(),
      expiresAt: Date.now() + ENTRY_COMMAND_TTL_MS,
      operationKey,
    }
    pendingEntryCommandRef.current = next
    storePendingEntryCommand(next)
    return next.commandId
  }, [])

  const acceptProfileSession = useCallback(
    (session: PlayerProfileSession | null) => {
      profileSessionRef.current = session
      setProfileSession(session)
      storeProfileSession(session)
    },
    [],
  )

  const syncProfileFromSnapshot = useCallback(
    (nextSnapshot: RoomSnapshot, player: SessionIdentity['player']) => {
      const nextProfile = nextSnapshot.players[player]?.profile
      const currentSession = profileSessionRef.current

      if (
        !nextProfile ||
        !currentSession ||
        currentSession.credentials.profileId !== nextProfile.id
      ) {
        return
      }

      acceptProfileSession({
        ...currentSession,
        profile: nextProfile,
      })
    },
    [acceptProfileSession],
  )

  const acceptSnapshot = useCallback(
    (nextSnapshot: RoomSnapshot, player?: SessionIdentity['player']) => {
      const currentSnapshot = snapshotRef.current

      if (
        currentSnapshot?.roomCode === nextSnapshot.roomCode &&
        currentSnapshot.revision > nextSnapshot.revision
      ) {
        return
      }

      snapshotRef.current = nextSnapshot
      setSnapshot(nextSnapshot)

      if (player) {
        syncProfileFromSnapshot(nextSnapshot, player)
      }
    },
    [syncProfileFromSnapshot],
  )

  const ensurePlayerProfile = useCallback(
    async (
      displayName: string,
      avatarKey: PlayerAvatarKey,
    ): Promise<PlayerProfileSession> => {
      const currentSession = profileSessionRef.current

      try {
        const session = await requestProfileSession({
          credentials: currentSession?.credentials,
          displayName,
          avatarKey,
        })
        acceptProfileSession(session)
        return session
      } catch (requestError) {
        if (
          requestError instanceof Error &&
          requestError.name === 'InvalidProfileError'
        ) {
          acceptProfileSession(null)
          const session = await requestProfileSession({
            displayName,
            avatarKey,
          })
          acceptProfileSession(session)
          return session
        }

        throw requestError
      }
    },
    [acceptProfileSession],
  )

  const clearSession = useCallback(
    (nextError: string | null = null) => {
      clearPendingTimer()
      identityRef.current = null
      snapshotRef.current = null
      setIdentity(null)
      setSnapshot(null)
      setIsSubmitting(false)
      setError(nextError)
      storeIdentity(null)
      updateRoomQuery(null)
      setConnectionState(
        socketRef.current?.connected ? 'lobby' : 'connecting',
      )
    },
    [clearPendingTimer],
  )

  const acceptJoinResponse = useCallback(
    (response: JoinRoomResponse, isResume = false) => {
      clearPendingTimer()
      setIsSubmitting(false)

      if (!isResume) {
        clearPendingEntryCommand()
      }

      if (!response.ok) {
        if (
          isResume &&
          (response.error.code === 'ROOM_NOT_FOUND' ||
            response.error.code === 'SESSION_INVALID')
        ) {
          clearSession(response.error.message)
          return
        }

        setError(response.error.message)
        setConnectionState(
          socketRef.current?.connected ? 'lobby' : 'connecting',
        )
        return
      }

      identityRef.current = response.identity
      setIdentity(response.identity)
      acceptSnapshot(response.snapshot, response.identity.player)
      setError(null)
      setConnectionState('connected')
      storeIdentity(response.identity)
      updateRoomQuery(response.identity.roomCode)
    },
    [
      acceptSnapshot,
      clearPendingEntryCommand,
      clearPendingTimer,
      clearSession,
    ],
  )

  const startCommandTimer = useCallback((message: string) => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current)
    }

    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null
      setIsSubmitting(false)
      setError(message)
    }, COMMAND_TIMEOUT_MS)
  }, [])

  const acceptCommandResponse = useCallback(
    (response: RoomCommandResponse) => {
      clearPendingTimer()
      setIsSubmitting(false)

      if (!response.ok) {
        if (response.snapshot) {
          acceptSnapshot(
            response.snapshot,
            identityRef.current?.player,
          )
        }
        setError(response.error.message)
        return
      }

      if (response.snapshot) {
        const currentIdentity = identityRef.current
        acceptSnapshot(response.snapshot, currentIdentity?.player)
      }
      setError(null)
    },
    [acceptSnapshot, clearPendingTimer],
  )

  useEffect(() => {
    identityRef.current = identity
  }, [identity])

  useEffect(() => {
    profileSessionRef.current = profileSession
  }, [profileSession])

  useEffect(() => {
    const storedSession = profileSessionRef.current

    if (!enabled || !storedSession) {
      return
    }

    let active = true
    void requestProfileSession({
      credentials: storedSession.credentials,
    })
      .then((session) => {
        if (active) {
          acceptProfileSession(session)
        }
      })
      .catch((requestError: unknown) => {
        if (!active) {
          return
        }

        if (
          requestError instanceof Error &&
          requestError.name === 'InvalidProfileError'
        ) {
          acceptProfileSession(null)
        }
      })

    return () => {
      active = false
    }
  }, [acceptProfileSession, enabled])

  useEffect(() => {
    if (!enabled) {
      socketRef.current?.disconnect()
      socketRef.current = null
      setConnectionState('disabled')
      setIsSubmitting(false)
      clearPendingTimer()
      directoryRevisionRef.current = null
      directoryRefreshPendingRef.current = false
      directoryRefreshAgainRef.current = false
      setRooms([])
      return
    }

    const socket: GameSocket = io({
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4_000,
    })
    socketRef.current = socket
    setConnectionState('connecting')

    socket.on('connect', () => {
      setError(null)
      directoryRevisionRef.current = null
      directoryRefreshPendingRef.current = false
      directoryRefreshAgainRef.current = false
      requestDirectory(socket)
      const savedIdentity = identityRef.current

      if (!savedIdentity) {
        setConnectionState('lobby')
        return
      }

      setConnectionState('connecting')
      setIsSubmitting(true)
      startCommandTimer('The saved room took too long to reconnect.')
      socket.emit(
        'room:resume',
        {
          commandId: globalThis.crypto.randomUUID(),
          roomCode: savedIdentity.roomCode,
          sessionToken: savedIdentity.sessionToken,
        },
        (response) => acceptJoinResponse(response, true),
      )
    })

    socket.on('disconnect', () => {
      if (identityRef.current) {
        setConnectionState('reconnecting')
      } else {
        setConnectionState('connecting')
      }
    })

    socket.on('connect_error', () => {
      setError('Unable to reach the game server. Retrying the connection.')
      setConnectionState(
        identityRef.current ? 'reconnecting' : 'connecting',
      )
    })

    socket.on('room:snapshot', (nextSnapshot) => {
      if (
        nextSnapshot.protocolVersion === PROTOCOL_VERSION &&
        nextSnapshot.roomCode === identityRef.current?.roomCode
      ) {
        acceptSnapshot(nextSnapshot, identityRef.current?.player)
        setConnectionState('connected')
      }
    })

    socket.on('rooms:delta', (delta) => {
      const currentRevision = directoryRevisionRef.current
      const action = getRoomDirectoryDeltaAction(
        currentRevision,
        delta.revision,
      )

      if (action === 'ignore') {
        return
      }

      if (action === 'refresh') {
        requestDirectory(socket)
        return
      }

      directoryRevisionRef.current = delta.revision
      setRooms((currentRooms) =>
        applyRoomDirectoryDelta(currentRooms, delta),
      )
    })

    socket.on('room:closed', (event) => {
      if (event.roomCode === identityRef.current?.roomCode) {
        clearSession(event.reason)
      }
    })

    socket.connect()

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
      clearPendingTimer()
      directoryRefreshPendingRef.current = false
      directoryRefreshAgainRef.current = false
    }
  }, [
    acceptJoinResponse,
    acceptSnapshot,
    clearPendingTimer,
    clearSession,
    enabled,
    requestDirectory,
    startCommandTimer,
  ])

  const createRoom = useCallback(
    (
      name: string,
      roomName: string,
      visibility: RoomVisibility,
      avatarKey: PlayerAvatarKey,
      password?: string,
    ) => {
      const socket = socketRef.current

      if (!socket?.connected) {
        setError('The game server is still connecting.')
        return
      }

      setError(null)
      setIsSubmitting(true)
      startCommandTimer('Room creation timed out.')
      const commandId = entryCommandId(
        `create:${name}:${roomName}:${visibility}`,
      )
      void ensurePlayerProfile(name, avatarKey)
        .then((session) => {
          if (!socket.connected) {
            throw new Error('The game server disconnected.')
          }

          socket.emit(
            'room:create',
            {
              commandId,
              name,
              roomName,
              visibility,
              password,
              profile: session.credentials,
            },
            acceptJoinResponse,
          )
        })
        .catch((requestError: unknown) => {
          clearPendingEntryCommand()
          clearPendingTimer()
          setIsSubmitting(false)
          setError(
            requestError instanceof DOMException &&
              requestError.name === 'AbortError'
              ? 'Player profile setup timed out.'
              : requestError instanceof Error
                ? requestError.message
                : 'Player profiles are unavailable.',
          )
        })
    },
    [
      acceptJoinResponse,
      clearPendingTimer,
      clearPendingEntryCommand,
      entryCommandId,
      ensurePlayerProfile,
      startCommandTimer,
    ],
  )

  const joinRoom = useCallback(
    (
      name: string,
      roomCode: string,
      avatarKey: PlayerAvatarKey,
      password?: string,
    ) => {
      const socket = socketRef.current

      if (!socket?.connected) {
        setError('The game server is still connecting.')
        return
      }

      setError(null)
      setIsSubmitting(true)
      startCommandTimer('Joining the room timed out.')
      const commandId = entryCommandId(
        `join:${roomCode.trim().toUpperCase()}:${name}`,
      )
      void ensurePlayerProfile(name, avatarKey)
        .then((session) => {
          if (!socket.connected) {
            throw new Error('The game server disconnected.')
          }

          socket.emit(
            'room:join',
            {
              commandId,
              name,
              roomCode,
              password,
              profile: session.credentials,
            },
            acceptJoinResponse,
          )
        })
        .catch((requestError: unknown) => {
          clearPendingEntryCommand()
          clearPendingTimer()
          setIsSubmitting(false)
          setError(
            requestError instanceof DOMException &&
              requestError.name === 'AbortError'
              ? 'Player profile setup timed out.'
              : requestError instanceof Error
                ? requestError.message
                : 'Player profiles are unavailable.',
          )
        })
    },
    [
      acceptJoinResponse,
      clearPendingTimer,
      clearPendingEntryCommand,
      entryCommandId,
      ensurePlayerProfile,
      startCommandTimer,
    ],
  )

  const leaveRoom = useCallback(() => {
    const socket = socketRef.current
    const currentIdentity = identityRef.current

    if (socket?.connected && currentIdentity) {
      socket.emit(
        'room:leave',
        {
          commandId: globalThis.crypto.randomUUID(),
          roomCode: currentIdentity.roomCode,
          sessionToken: currentIdentity.sessionToken,
        },
        () => undefined,
      )
    }

    clearSession()
  }, [clearSession])

  const refreshRooms = useCallback(() => {
    requestDirectory()
  }, [requestDirectory])

  const play = useCallback(
    (index: number) => {
      const socket = socketRef.current
      const currentIdentity = identityRef.current

      if (!socket?.connected || !currentIdentity || !snapshot) {
        return
      }

      setIsSubmitting(true)
      startCommandTimer('The move timed out.')
      socket.emit(
        'game:play',
        {
          commandId: globalThis.crypto.randomUUID(),
          roomCode: currentIdentity.roomCode,
          sessionToken: currentIdentity.sessionToken,
          revision: snapshot.revision,
          index,
        },
        acceptCommandResponse,
      )
    },
    [acceptCommandResponse, snapshot, startCommandTimer],
  )

  const nextRound = useCallback(() => {
    const socket = socketRef.current
    const currentIdentity = identityRef.current

    if (!socket?.connected || !currentIdentity || !snapshot) {
      return
    }

    setIsSubmitting(true)
    startCommandTimer('The rematch response timed out.')
    socket.emit(
      'game:ready-next',
      {
        commandId: globalThis.crypto.randomUUID(),
        roomCode: currentIdentity.roomCode,
        sessionToken: currentIdentity.sessionToken,
        revision: snapshot.revision,
      },
      acceptCommandResponse,
    )
  }, [acceptCommandResponse, snapshot, startCommandTimer])

  const gameSession = useMemo<GameSession | null>(() => {
    if (!snapshot || !identity) {
      return null
    }

    const bothPlayersConnected = Boolean(
      snapshot.players.X?.connected && snapshot.players.O?.connected,
    )
    const playerReady = snapshot.readyForNextRound.includes(identity.player)

    return {
      state: snapshot.match,
      canPlay:
        connectionState === 'connected' &&
        bothPlayersConnected &&
        snapshot.match.round.status === 'playing' &&
        snapshot.match.round.currentPlayer === identity.player &&
        !isSubmitting,
      canRestartRound: false,
      canNextRound:
        connectionState === 'connected' &&
        bothPlayersConnected &&
        snapshot.match.round.status !== 'playing' &&
        !playerReady &&
        !isSubmitting,
      canResetMatch: false,
      play,
      restartRound: () => undefined,
      nextRound,
      resetMatch: () => undefined,
    }
  }, [
    connectionState,
    identity,
    isSubmitting,
    nextRound,
    play,
    snapshot,
  ])

  return {
    connectionState,
    error,
    gameSession,
    identity,
    isSubmitting,
    profile: profileSession?.profile ?? null,
    rooms,
    snapshot,
    clearError: () => setError(null),
    createRoom,
    joinRoom,
    leaveRoom,
    refreshRooms,
  }
}
