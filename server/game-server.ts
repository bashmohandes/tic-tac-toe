import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { resolve } from 'node:path'
import express, {
  type Express,
  type Request,
  type Response,
} from 'express'
import helmet from 'helmet'
import { Server } from 'socket.io'
import {
  createRoomPayloadSchema,
  joinRoomPayloadSchema,
  leaveRoomPayloadSchema,
  playMovePayloadSchema,
  profileSessionPayloadSchema,
  roomCommandPayloadSchema,
  roomSessionPayloadSchema,
  type ClientToServerEvents,
  type InterServerEvents,
  type JoinRoomResponse,
  type RoomCommandResponse,
  type RoomError,
  type ServerToClientEvents,
  type SocketData,
  type PublicPlayerProfile,
} from '../src/game/protocol'
import {
  createHistoryStore,
  deploymentIdentity,
} from './history/create-history'
import { HistoryRecorder } from './history/recorder'
import type { HistoryStore } from './history/store'
import { createProfileStore } from './profiles/create-profile-store'
import {
  InvalidProfileError,
  ProfileService,
} from './profiles/profile-service'
import type { ProfileStore } from './profiles/store'
import { RoomManager } from './room-manager'
import { createRoomStateStore } from './rooms/create-room-store'
import type { RoomStateStore } from './rooms/store'

const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_COMMANDS = 40
const PROFILE_CREATION_RATE_LIMIT_WINDOW_MS = 10 * 60_000
const PROFILE_CREATION_RATE_LIMIT_MAX_REQUESTS = 10
const PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS = 10_000

interface RateLimitState {
  count: number
  windowStartedAt: number
}

interface ProfileCreationRateLimit {
  readonly maxRequests: number
  readonly windowMs: number
}

export interface GameServerOptions {
  readonly allowedOrigins?: readonly string[]
  readonly disconnectGraceMs?: number
  readonly roomTtlMs?: number
  readonly staticDirectory?: string
  readonly historyStore?: HistoryStore
  readonly profileStore?: ProfileStore
  readonly roomStore?: RoomStateStore
  readonly adminApiKey?: string
  readonly profileCreationRateLimit?: ProfileCreationRateLimit
  readonly trustProxy?: boolean | number | string
}

export interface GameServer {
  readonly app: Express
  readonly io: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >
  readonly roomManager: RoomManager
  readonly history: HistoryRecorder
  readonly profiles: ProfileService
  readonly listen: (
    port: number,
    host?: string,
  ) => Promise<{ readonly host: string; readonly port: number }>
  readonly close: () => Promise<void>
}

function invalidRequest(message: string): RoomError {
  return {
    code: 'INVALID_REQUEST',
    message,
  }
}

function firstValidationMessage(
  result: { readonly error: { readonly issues: readonly { message: string }[] } },
  fallback: string,
): string {
  return result.error.issues[0]?.message ?? fallback
}

function isOriginAllowed(
  origin: string | undefined,
  requestHost: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) {
    return true
  }

  if (allowedOrigins.includes(origin)) {
    return true
  }

  try {
    const parsedOrigin = new URL(origin)

    if (requestHost && parsedOrigin.host === requestHost) {
      return true
    }

    if (
      process.env.NODE_ENV !== 'production' &&
      (parsedOrigin.hostname === '127.0.0.1' ||
        parsedOrigin.hostname === 'localhost')
    ) {
      return true
    }
  } catch {
    return false
  }

  return false
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return parsed >= 1 && parsed <= maximum ? parsed : fallback
}

function getAdminCredential(request: Request): string | null {
  const directKey = request.get('x-admin-api-key')

  if (directKey) {
    return directKey
  }

  const authorization = request.get('authorization')
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null
}

function credentialsMatch(
  provided: string | null,
  expected: string,
): boolean {
  if (!provided) {
    return false
  }

  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)

  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  )
}

function parseTrustProxy(
  value: string | undefined,
): boolean | number | string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value === 'true' || value === 'false') {
    return value === 'true'
  }

  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value
}

export function createGameServer(
  options: GameServerOptions = {},
): GameServer {
  const app = express()
  const trustProxy =
    options.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY)

  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy)
  }

  const httpServer = createHttpServer(app)
  const configuredOrigins =
    options.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    allowRequest: (request, callback) => {
      callback(
        null,
        isOriginAllowed(
          request.headers.origin,
          request.headers.host,
          configuredOrigins,
        ),
      )
    },
    cors: {
      origin: true,
    },
    maxHttpBufferSize: 10_000,
    serveClient: false,
  })
  const history = new HistoryRecorder(
    options.historyStore ?? createHistoryStore(),
    deploymentIdentity(),
  )
  const profiles = new ProfileService(
    options.profileStore ?? createProfileStore(),
    {
      onHistoryEvent: (event) => history.record(event),
    },
  )
  const adminApiKey = options.adminApiKey ?? process.env.ADMIN_API_KEY

  const roomManager = new RoomManager({
    disconnectGraceMs: options.disconnectGraceMs,
    roomTtlMs: options.roomTtlMs,
    roomStore: options.roomStore ?? createRoomStateStore(),
    onSnapshot: (snapshot) => {
      io.to(snapshot.roomCode).emit('room:snapshot', snapshot)
    },
    onDirectoryDelta: (delta) => {
      io.emit('rooms:delta', delta)
    },
    onHistoryEvent: (event) => {
      history.record(event)
    },
    onProfileRoundCompleted: (round) => {
      void profiles
        .recordRound(
          round.xProfileId,
          round.oProfileId,
          round.outcome,
        )
        .catch((error: unknown) => {
          console.error('Player profile score update failed.', error)
        })
    },
    onRoomClosed: (roomCode, reason) => {
      const roomSockets = io.sockets.adapter.rooms.get(roomCode)

      if (roomSockets) {
        for (const socketId of roomSockets) {
          const roomSocket = io.sockets.sockets.get(socketId)

          if (roomSocket) {
            delete roomSocket.data.roomCode
            delete roomSocket.data.player
          }
        }
      }

      io.to(roomCode).emit('room:closed', { roomCode, reason })
      io.in(roomCode).socketsLeave(roomCode)
    },
  })
  const rateLimits = new Map<string, RateLimitState>()
  const profileCreationRateLimits = new Map<string, RateLimitState>()
  const profileCreationRateLimit =
    options.profileCreationRateLimit ?? {
      maxRequests: parseBoundedInteger(
        process.env.PROFILE_CREATION_RATE_LIMIT_MAX,
        PROFILE_CREATION_RATE_LIMIT_MAX_REQUESTS,
        10_000,
      ),
      windowMs: parseBoundedInteger(
        process.env.PROFILE_CREATION_RATE_LIMIT_WINDOW_MS,
        PROFILE_CREATION_RATE_LIMIT_WINDOW_MS,
        24 * 60 * 60_000,
      ),
    }

  app.disable('x-powered-by')
  app.use(
    helmet({
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production' ? undefined : false,
    }),
  )
  app.use(express.json({ limit: '10kb' }))
  app.get('/health', (_request, response) => {
    response.status(200).json({
      status: 'ok',
      rooms: roomManager.roomCount,
      uptimeSeconds: Math.floor(process.uptime()),
      history: {
        backend: history.backend,
        status: history.status,
      },
      profiles: {
        backend: profiles.backend,
        status: profiles.status,
      },
      roomState: {
        backend: roomManager.backend,
        status: roomManager.status,
      },
    })
  })

  app.post('/api/profiles/session', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    const parsed = profileSessionPayloadSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        code: 'INVALID_REQUEST',
        error: firstValidationMessage(
          parsed,
          'Enter valid player profile details.',
        ),
      })
      return
    }

    if (!parsed.data.credentials) {
      const now = Date.now()
      const clientKey =
        request.ip ?? request.socket.remoteAddress ?? 'unknown'
      let state = profileCreationRateLimits.get(clientKey)

      if (
        state &&
        now - state.windowStartedAt >= profileCreationRateLimit.windowMs
      ) {
        profileCreationRateLimits.delete(clientKey)
        state = undefined
      }

      if (!state) {
        if (
          profileCreationRateLimits.size >=
          PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS
        ) {
          for (const [key, candidate] of profileCreationRateLimits) {
            if (
              now - candidate.windowStartedAt >=
              profileCreationRateLimit.windowMs
            ) {
              profileCreationRateLimits.delete(key)
            }
          }
        }

        if (
          profileCreationRateLimits.size >=
          PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS
        ) {
          response.setHeader(
            'Retry-After',
            Math.ceil(profileCreationRateLimit.windowMs / 1_000),
          )
          response.status(429).json({
            ok: false,
            code: 'RATE_LIMITED',
            error: 'Profile creation is busy. Try again later.',
          })
          return
        }

        state = {
          count: 0,
          windowStartedAt: now,
        }
        profileCreationRateLimits.set(clientKey, state)
      }

      if (state.count >= profileCreationRateLimit.maxRequests) {
        const retryAfterMs =
          profileCreationRateLimit.windowMs -
          (now - state.windowStartedAt)
        response.setHeader(
          'Retry-After',
          Math.max(1, Math.ceil(retryAfterMs / 1_000)),
        )
        response.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          error: 'You reached the profile creation limit. Try again later.',
        })
        return
      }

      state.count += 1
    }

    try {
      response.status(200).json({
        ok: true,
        session: await profiles.ensureSession(parsed.data),
      })
    } catch (error) {
      if (error instanceof InvalidProfileError) {
        response.status(401).json({
          ok: false,
          code: 'INVALID_PROFILE',
          error: error.message,
        })
        return
      }

      console.error('Player profile request failed.', error)
      response.status(503).json({
        ok: false,
        code: 'UNAVAILABLE',
        error: 'Player profiles are unavailable.',
      })
    }
  })

  function authorizeAdmin(
    request: Request,
    response: Response,
  ): boolean {
    response.setHeader('Cache-Control', 'no-store')

    if (!adminApiKey) {
      response.status(503).json({
        error: 'History administration is not configured.',
      })
      return false
    }

    if (!credentialsMatch(getAdminCredential(request), adminApiKey)) {
      response.status(401).json({ error: 'Invalid operator key.' })
      return false
    }

    return true
  }

  app.get('/api/admin/history/summary', async (request, response) => {
    if (!authorizeAdmin(request, response)) {
      return
    }

    const hours = parseBoundedInteger(request.query.hours, 24, 24 * 366)

    try {
      response.status(200).json(await history.getSummary(hours))
    } catch (error) {
      console.error('History summary query failed.', error)
      response.status(503).json({
        error: 'History is unavailable.',
      })
    }
  })

  app.get('/api/admin/history/events', async (request, response) => {
    if (!authorizeAdmin(request, response)) {
      return
    }

    const hours = parseBoundedInteger(request.query.hours, 24, 24 * 366)
    const limit = parseBoundedInteger(request.query.limit, 50, 200)
    const beforeValue = request.query.before
    const before =
      typeof beforeValue === 'string' ? new Date(beforeValue) : undefined

    if (before && Number.isNaN(before.getTime())) {
      response.status(400).json({ error: 'Invalid history cursor.' })
      return
    }

    try {
      response.status(200).json(
        await history.getEvents(hours, limit, before),
      )
    } catch (error) {
      console.error('History event query failed.', error)
      response.status(503).json({
        error: 'History is unavailable.',
      })
    }
  })

  const staticDirectory = resolve(options.staticDirectory ?? 'dist')
  const indexFile = resolve(staticDirectory, 'index.html')

  if (existsSync(indexFile)) {
    app.use(express.static(staticDirectory, { index: false }))
    app.use((request, response, next) => {
      if (
        request.method === 'GET' &&
        request.accepts('html') &&
        !request.path.startsWith('/socket.io')
      ) {
        response.sendFile(indexFile)
        return
      }

      next()
    })
  }

  function consumeRateLimit(socketId: string): boolean {
    const now = Date.now()
    const state = rateLimits.get(socketId)

    if (!state || now - state.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimits.set(socketId, {
        count: 1,
        windowStartedAt: now,
      })
      return true
    }

    state.count += 1
    return state.count <= RATE_LIMIT_MAX_COMMANDS
  }

  function rateLimitResponse(): RoomCommandResponse {
    return {
      ok: false,
      error: rateLimitError(),
    }
  }

  function rateLimitError(): RoomError {
    return {
      code: 'RATE_LIMITED',
      message: 'Too many actions arrived at once. Wait a moment.',
    }
  }

  function rateLimitJoinResponse(): JoinRoomResponse {
    return {
      ok: false,
      error: rateLimitError(),
    }
  }

  async function resolveSocketProfile(
    credentials:
      | Parameters<ProfileService['authenticate']>[0]
      | undefined,
  ): Promise<
    | {
        readonly ok: true
        readonly profile?: PublicPlayerProfile
      }
    | {
        readonly ok: false
        readonly error: RoomError
      }
  > {
    if (!credentials) {
      return { ok: true }
    }

    try {
      return {
        ok: true,
        profile: await profiles.authenticate(credentials),
      }
    } catch (error) {
      if (error instanceof InvalidProfileError) {
        return {
          ok: false,
          error: {
            code: 'PROFILE_INVALID',
            message: 'Refresh your player profile and try again.',
          },
        }
      }

      console.error('Player profile authentication failed.', error)
      return {
        ok: false,
        error: {
          code: 'ROOM_UNAVAILABLE',
          message: 'Player profiles are unavailable.',
        },
      }
    }
  }

  io.on('connection', (socket) => {
    socket.on('rooms:list', async (ack) => {
      ack(await roomManager.getDirectory())
    })

    socket.on('room:create', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse())
        return
      }

      if (socket.data.roomCode) {
        ack({
          ok: false,
          error: {
            code: 'ALREADY_IN_ROOM',
            message: 'Leave the current room before creating another one.',
          },
        })
        return
      }

      const parsed = createRoomPayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest(
            firstValidationMessage(parsed, 'Enter a valid display name.'),
          ),
        })
        return
      }

      const profileResult = await resolveSocketProfile(parsed.data.profile)

      if (!profileResult.ok) {
        ack({ ok: false, error: profileResult.error })
        return
      }

      const response = await roomManager.createRoom(
        {
          commandId: parsed.data.commandId,
          name: parsed.data.name,
          roomName: parsed.data.roomName,
          visibility: parsed.data.visibility,
          password: parsed.data.password,
          profile: profileResult.profile,
        },
        socket.id,
      )

      if (response.ok) {
        if (socket.connected) {
          socket.join(response.identity.roomCode)
          socket.data.roomCode = response.identity.roomCode
          socket.data.player = response.identity.player
        } else {
          await roomManager.disconnect(socket.id)
        }
      }

      ack(response)
    })

    socket.on('room:join', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse())
        return
      }

      if (socket.data.roomCode) {
        ack({
          ok: false,
          error: {
            code: 'ALREADY_IN_ROOM',
            message: 'Leave the current room before joining another one.',
          },
        })
        return
      }

      const parsed = joinRoomPayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest(
            firstValidationMessage(parsed, 'Enter valid room details.'),
          ),
        })
        return
      }

      const profileResult = await resolveSocketProfile(parsed.data.profile)

      if (!profileResult.ok) {
        ack({ ok: false, error: profileResult.error })
        return
      }

      let rivalry
      const hostProfileId = roomManager.getHostProfileId(
        parsed.data.roomCode,
      )

      if (
        profileResult.profile &&
        hostProfileId &&
        hostProfileId !== profileResult.profile.id
      ) {
        try {
          rivalry = await profiles.getRivalry(
            hostProfileId,
            profileResult.profile.id,
          )
        } catch (error) {
          console.error('Player rivalry lookup failed.', error)
          ack({
            ok: false,
            error: {
              code: 'ROOM_UNAVAILABLE',
              message: 'Player profiles are unavailable.',
            },
          })
          return
        }
      }

      const response = await roomManager.joinRoom(
        parsed.data.roomCode,
        parsed.data.name,
        parsed.data.password,
        socket.id,
        profileResult.profile,
        rivalry,
        parsed.data.commandId,
      )

      if (response.ok) {
        if (socket.connected) {
          socket.join(response.identity.roomCode)
          socket.data.roomCode = response.identity.roomCode
          socket.data.player = response.identity.player
        } else {
          await roomManager.disconnect(socket.id)
        }
      }

      ack(response)
    })

    socket.on('room:resume', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse())
        return
      }

      const parsed = roomSessionPayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest('The saved room session is invalid.'),
        })
        return
      }

      const response = await roomManager.resumeRoom(
        parsed.data.roomCode,
        parsed.data.sessionToken,
        socket.id,
        parsed.data.commandId,
      )

      if (response.ok) {
        socket.join(response.identity.roomCode)
        socket.data.roomCode = response.identity.roomCode
        socket.data.player = response.identity.player
      }

      ack(response)
    })

    socket.on('game:play', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse())
        return
      }

      const parsed = playMovePayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest('That move request is invalid.'),
        })
        return
      }

      ack(await roomManager.playMove(parsed.data, socket.id))
    })

    socket.on('game:ready-next', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse())
        return
      }

      const parsed = roomCommandPayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest('That next-round request is invalid.'),
        })
        return
      }

      ack(await roomManager.readyForNextRound(parsed.data, socket.id))
    })

    socket.on('room:leave', async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse())
        return
      }

      const parsed = leaveRoomPayloadSchema.safeParse(payload)

      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest('That leave request is invalid.'),
        })
        return
      }

      const roomCode = parsed.data.roomCode
      const response = await roomManager.leaveRoom(parsed.data, socket.id)

      if (response.ok) {
        socket.leave(roomCode)
        delete socket.data.roomCode
        delete socket.data.player
      }

      ack(response)
    })

    socket.on('disconnect', () => {
      rateLimits.delete(socket.id)
      void roomManager.disconnect(socket.id)
    })
  })

  async function listen(
    port: number,
    host = '0.0.0.0',
  ): Promise<{ readonly host: string; readonly port: number }> {
    await history.initialize()
    try {
      await profiles.initialize()
      await roomManager.initialize()
    } catch (error) {
      await Promise.allSettled([
        roomManager.close(),
        profiles.close(),
        history.close(),
      ])
      throw error
    }
    const address = await new Promise<{
      readonly host: string
      readonly port: number
    }>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        httpServer.off('error', onError)
        const serverAddress = httpServer.address()

        if (!serverAddress || typeof serverAddress === 'string') {
          reject(new Error('The game server did not expose a TCP address.'))
          return
        }

        resolvePromise({
          host,
          port: serverAddress.port,
        })
      }

      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(port, host)
    })

    history.record({
      type: 'service_started',
      payload: {
        environment: process.env.NODE_ENV ?? 'development',
        historyBackend: history.backend,
        profileBackend: profiles.backend,
        roomStateBackend: roomManager.backend,
      },
    })
    await history.flush()
    return address
  }

  let closePromise: Promise<void> | null = null

  function close(): Promise<void> {
    closePromise ??= (async () => {
      history.record({
        type: 'service_stopped',
        payload: {
          uptimeSeconds: Math.floor(process.uptime()),
        },
      })

      await roomManager.close()
      await new Promise<void>((resolvePromise) => {
        io.close(() => {
          resolvePromise()
        })
      })
      await Promise.all([profiles.close(), history.close()])
    })()

    return closePromise
  }

  return {
    app,
    io,
    roomManager,
    history,
    profiles,
    listen,
    close,
  }
}
