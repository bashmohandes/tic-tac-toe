import { z } from 'zod'
import type { MatchState } from './match'
import type { Player } from './engine'

export const PROTOCOL_VERSION = 4 as const
export const ROOM_CODE_LENGTH = 6
export const PLAYER_NAME_MAX_LENGTH = 24
export const ROOM_NAME_MAX_LENGTH = 32
export const ROOM_PASSWORD_MIN_LENGTH = 6
export const ROOM_PASSWORD_MAX_LENGTH = 64
export const PLAYER_AVATAR_KEYS = [
  'coral',
  'teal',
  'gold',
  'sky',
  'violet',
  'green',
] as const

export type RoomVisibility = 'public' | 'private'
export type PlayerAvatarKey = (typeof PLAYER_AVATAR_KEYS)[number]

export const normalizedPlayerNameSchema = z
  .string()
  .transform((name) => name.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter a display name.')
      .max(
        PLAYER_NAME_MAX_LENGTH,
        `Names can use up to ${PLAYER_NAME_MAX_LENGTH} characters.`,
      )
      .refine(
        (name) =>
          [...name].every((character) => {
            const codePoint = character.codePointAt(0) ?? 0
            return codePoint > 31 && codePoint !== 127
          }),
        'Names cannot contain control characters.',
      ),
  )

export const profileCredentialsSchema = z
  .object({
    profileId: z.string().uuid(),
    profileToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'The player profile token is invalid.'),
  })
  .strict()

export const playerRecordSchema = z
  .object({
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
  })
  .strict()

export const publicPlayerProfileSchema = z
  .object({
    id: z.string().uuid(),
    displayName: normalizedPlayerNameSchema,
    avatarKey: z.enum(PLAYER_AVATAR_KEYS),
    record: playerRecordSchema,
    createdAt: z.string().datetime(),
  })
  .strict()

export const playerProfileSessionSchema = z
  .object({
    credentials: profileCredentialsSchema,
    profile: publicPlayerProfileSchema,
  })
  .strict()

export const profileSessionPayloadSchema = z
  .object({
    credentials: profileCredentialsSchema.optional(),
    displayName: normalizedPlayerNameSchema.optional(),
    avatarKey: z.enum(PLAYER_AVATAR_KEYS).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      !payload.credentials &&
      (!payload.displayName || !payload.avatarKey)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Choose a display name and profile color.',
      })
    }

    if (
      (payload.displayName && !payload.avatarKey) ||
      (!payload.displayName && payload.avatarKey)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Update the display name and profile color together.',
      })
    }
  })

export const commandIdSchema = z.string().uuid()

export const createRoomPayloadSchema = z
  .object({
    commandId: commandIdSchema,
    name: normalizedPlayerNameSchema,
    roomName: z
      .string()
      .transform((name) => name.trim().replace(/\s+/g, ' '))
      .pipe(
        z
          .string()
          .min(1, 'Enter a room name.')
          .max(
            ROOM_NAME_MAX_LENGTH,
            `Room names can use up to ${ROOM_NAME_MAX_LENGTH} characters.`,
          )
          .refine(
            (name) =>
              [...name].every((character) => {
                const codePoint = character.codePointAt(0) ?? 0
                return codePoint > 31 && codePoint !== 127
              }),
            'Room names cannot contain control characters.',
          ),
      ),
    visibility: z.enum(['public', 'private']),
    password: z.string().max(ROOM_PASSWORD_MAX_LENGTH).optional(),
    profile: profileCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((room, context) => {
    if (
      room.visibility === 'private' &&
      (!room.password || room.password.length < ROOM_PASSWORD_MIN_LENGTH)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Passwords need at least ${ROOM_PASSWORD_MIN_LENGTH} characters.`,
        path: ['password'],
      })
    }
  })

export const joinRoomPayloadSchema = z
  .object({
    commandId: commandIdSchema,
    name: normalizedPlayerNameSchema,
    roomCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-HJ-NP-Z2-9]{6}$/, 'Enter a valid six-character room code.'),
    password: z.string().max(ROOM_PASSWORD_MAX_LENGTH).optional(),
    profile: profileCredentialsSchema.optional(),
  })
  .strict()

export const roomSessionPayloadSchema = z
  .object({
    commandId: commandIdSchema,
    roomCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-HJ-NP-Z2-9]{6}$/),
    sessionToken: z.string().uuid(),
  })
  .strict()

export const roomCommandPayloadSchema = roomSessionPayloadSchema.extend({
  revision: z.number().int().nonnegative(),
})

export const playMovePayloadSchema = roomCommandPayloadSchema.extend({
  index: z.number().int().min(0).max(8),
})

export const leaveRoomPayloadSchema = roomCommandPayloadSchema.omit({
  revision: true,
})

export const sessionIdentitySchema = z
  .object({
    roomCode: joinRoomPayloadSchema.shape.roomCode,
    sessionToken: z.string().uuid(),
    player: z.enum(['X', 'O']),
    name: normalizedPlayerNameSchema,
    profileId: z.string().uuid(),
  })
  .strict()

export type CreateRoomPayload = z.input<typeof createRoomPayloadSchema>
export type JoinRoomPayload = z.input<typeof joinRoomPayloadSchema>
export type RoomSessionPayload = z.infer<typeof roomSessionPayloadSchema>
export type RoomCommandPayload = z.infer<typeof roomCommandPayloadSchema>
export type PlayMovePayload = z.infer<typeof playMovePayloadSchema>
export type LeaveRoomPayload = z.infer<typeof leaveRoomPayloadSchema>
export type ProfileCredentials = z.infer<typeof profileCredentialsSchema>
export type PlayerRecord = z.infer<typeof playerRecordSchema>
export type PublicPlayerProfile = z.infer<
  typeof publicPlayerProfileSchema
>
export type PlayerProfileSession = z.infer<
  typeof playerProfileSessionSchema
>
export type ProfileSessionPayload = z.input<
  typeof profileSessionPayloadSchema
>
export type ValidatedProfileSessionPayload = z.infer<
  typeof profileSessionPayloadSchema
>

export type ProfileSessionResponse =
  | {
      readonly ok: true
      readonly session: PlayerProfileSession
    }
  | {
      readonly ok: false
      readonly error: string
      readonly code:
        | 'INVALID_PROFILE'
        | 'INVALID_REQUEST'
        | 'RATE_LIMITED'
        | 'UNAVAILABLE'
    }

export interface RoomPlayerSnapshot {
  readonly mark: Player
  readonly name: string
  readonly connected: boolean
  readonly profile: PublicPlayerProfile
}

export interface RivalryRecord {
  readonly xWins: number
  readonly oWins: number
  readonly draws: number
}

export interface RoomSnapshot {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly roomCode: string
  readonly roomName: string
  readonly visibility: RoomVisibility
  readonly revision: number
  readonly match: MatchState
  readonly players: Readonly<Record<Player, RoomPlayerSnapshot | null>>
  readonly rivalry: RivalryRecord | null
  readonly readyForNextRound: readonly Player[]
}

export type SessionIdentity = z.infer<typeof sessionIdentitySchema>

export interface RoomDirectoryEntry {
  readonly roomCode: string
  readonly roomName: string
  readonly visibility: RoomVisibility
  readonly hostName: string
  readonly hostProfile: PublicPlayerProfile
  readonly hostConnected: boolean
  readonly playerCount: number
  readonly capacity: 2
}

export interface RoomDirectoryResponse {
  readonly rooms: readonly RoomDirectoryEntry[]
  readonly revision: number
}

export interface RoomDirectoryDelta {
  readonly revision: number
  readonly upserts: readonly RoomDirectoryEntry[]
  readonly removedRoomCodes: readonly string[]
}

export type RoomErrorCode =
  | 'ALREADY_IN_ROOM'
  | 'INVALID_PASSWORD'
  | 'INVALID_MOVE'
  | 'INVALID_REQUEST'
  | 'NOT_YOUR_TURN'
  | 'OPPONENT_OFFLINE'
  | 'PROFILE_IN_USE'
  | 'PROFILE_INVALID'
  | 'RATE_LIMITED'
  | 'ROOM_CLOSED'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_UNAVAILABLE'
  | 'ROUND_NOT_COMPLETE'
  | 'SESSION_INVALID'
  | 'STALE_STATE'

export interface RoomError {
  readonly code: RoomErrorCode
  readonly message: string
}

export type JoinRoomResponse =
  | {
      readonly ok: true
      readonly identity: SessionIdentity
      readonly snapshot: RoomSnapshot
    }
  | {
      readonly ok: false
      readonly error: RoomError
    }

export type RoomCommandResponse =
  | {
      readonly ok: true
      readonly snapshot: RoomSnapshot | null
    }
  | {
      readonly ok: false
      readonly error: RoomError
      readonly snapshot?: RoomSnapshot
    }

export interface RoomClosedEvent {
  readonly roomCode: string
  readonly reason: string
}

type Ack<Response> = (response: Response) => void

export interface ClientToServerEvents {
  'rooms:list': (ack: Ack<RoomDirectoryResponse>) => void
  'room:create': (
    payload: CreateRoomPayload,
    ack: Ack<JoinRoomResponse>,
  ) => void
  'room:join': (
    payload: JoinRoomPayload,
    ack: Ack<JoinRoomResponse>,
  ) => void
  'room:resume': (
    payload: RoomSessionPayload,
    ack: Ack<JoinRoomResponse>,
  ) => void
  'room:leave': (
    payload: LeaveRoomPayload,
    ack: Ack<RoomCommandResponse>,
  ) => void
  'game:play': (
    payload: PlayMovePayload,
    ack: Ack<RoomCommandResponse>,
  ) => void
  'game:ready-next': (
    payload: RoomCommandPayload,
    ack: Ack<RoomCommandResponse>,
  ) => void
}

export interface ServerToClientEvents {
  'rooms:delta': (delta: RoomDirectoryDelta) => void
  'room:snapshot': (snapshot: RoomSnapshot) => void
  'room:closed': (event: RoomClosedEvent) => void
}

export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string
  player?: Player
}
