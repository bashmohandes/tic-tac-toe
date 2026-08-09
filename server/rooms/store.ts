import { z } from 'zod'
import {
  normalizedPlayerNameSchema,
  publicPlayerProfileSchema,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  type JoinRoomResponse,
  type RoomCommandResponse,
} from '../../src/game/protocol'

export const ROOM_STATE_SCHEMA_VERSION = 1 as const

const playerSchema = z.enum(['X', 'O'])
const cellSchema = playerSchema.nullable()
const winningLineSchema = z
  .tuple([
    z.number().int().min(0).max(8),
    z.number().int().min(0).max(8),
    z.number().int().min(0).max(8),
  ])
  .nullable()
const matchStateSchema = z
  .object({
    round: z
      .object({
        board: z.array(cellSchema).length(9),
        currentPlayer: playerSchema,
        startingPlayer: playerSchema,
        status: z.enum(['playing', 'won', 'draw']),
        winner: playerSchema.nullable(),
        winningLine: winningLineSchema,
        moveCount: z.number().int().min(0).max(9),
      })
      .strict(),
    roundNumber: z.number().int().positive(),
    scores: z
      .object({
        X: z.number().int().nonnegative(),
        O: z.number().int().nonnegative(),
        draws: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
const rivalrySchema = z
  .object({
    xWins: z.number().int().nonnegative(),
    oWins: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
  })
  .strict()
  .nullable()
const passwordRecordSchema = z
  .object({
    saltBase64: z.string().min(1),
    hashBase64: z.string().min(1),
  })
  .strict()
  .nullable()
const persistedRoomPlayerSchema = z
  .object({
    id: z.string().uuid(),
    mark: playerSchema,
    name: normalizedPlayerNameSchema,
    profile: publicPlayerProfileSchema,
    persistentProfile: z.boolean(),
    sessionToken: z.string().uuid(),
    connected: z.boolean(),
    disconnectExpiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict()

export const persistedRoomSchema = z
  .object({
    schemaVersion: z.literal(ROOM_STATE_SCHEMA_VERSION),
    id: z.string().uuid(),
    code: z
      .string()
      .regex(
        new RegExp(`^[A-HJ-NP-Z2-9]{${ROOM_CODE_LENGTH}}$`),
      ),
    name: z.string().min(1).max(ROOM_NAME_MAX_LENGTH),
    visibility: z.enum(['public', 'private']),
    password: passwordRecordSchema,
    matchId: z.string().uuid().nullable(),
    match: matchStateSchema,
    rivalry: rivalrySchema,
    revision: z.number().int().nonnegative(),
    players: z
      .object({
        X: persistedRoomPlayerSchema,
        O: persistedRoomPlayerSchema.optional(),
      })
      .strict(),
    readyForNextRound: z.array(playerSchema).max(2),
    lastActivityAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((room, context) => {
    if (room.players.X.mark !== 'X' || room.players.O?.mark === 'X') {
      context.addIssue({
        code: 'custom',
        message: 'Stored room seats do not match their player marks.',
      })
    }
  })

export type PersistedRoom = z.infer<typeof persistedRoomSchema>
export type CachedCommandResponse =
  | JoinRoomResponse
  | RoomCommandResponse

export interface CommandReceipt {
  readonly key: string
  readonly response: CachedCommandResponse
  readonly expiresAt: number
}

export interface RoomStoreMutation {
  readonly upsert?: PersistedRoom
  readonly deleteRoomId?: string
  readonly receipt?: CommandReceipt
}

export interface RoomStateStore {
  readonly backend: 'memory' | 'postgres'
  initialize(): Promise<void>
  loadActiveRooms(now: number): Promise<readonly PersistedRoom[]>
  findReceipt(
    key: string,
    now: number,
  ): Promise<CachedCommandResponse | null>
  commit(mutation: RoomStoreMutation): Promise<void>
  close(): Promise<void>
}
