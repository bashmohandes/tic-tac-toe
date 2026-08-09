export const HISTORY_SCHEMA_VERSION = 1 as const

export type HistoryEventType =
  | 'service_started'
  | 'service_stopped'
  | 'profile_created'
  | 'profile_updated'
  | 'room_created'
  | 'room_recovered'
  | 'join_rejected'
  | 'player_joined'
  | 'match_started'
  | 'move_played'
  | 'round_completed'
  | 'round_started'
  | 'player_disconnected'
  | 'player_reconnected'
  | 'player_left'
  | 'match_ended'
  | 'room_closed'

export type HistoryValue =
  | boolean
  | number
  | string
  | null
  | readonly HistoryValue[]
  | { readonly [key: string]: HistoryValue }

export type HistoryPayload = Readonly<Record<string, HistoryValue>>

export interface HistoryEventDraft {
  readonly type: HistoryEventType
  readonly roomId?: string | null
  readonly matchId?: string | null
  readonly payload?: HistoryPayload
}

export interface HistoryEvent {
  readonly eventId: string
  readonly occurredAt: string
  readonly type: HistoryEventType
  readonly roomId: string | null
  readonly matchId: string | null
  readonly instanceId: string
  readonly releaseId: string | null
  readonly payload: HistoryPayload
  readonly schemaVersion: number
}

export interface HistoryCounts {
  readonly roomsCreated: number
  readonly matchesStarted: number
  readonly roundsCompleted: number
  readonly movesPlayed: number
  readonly playersJoined: number
  readonly joinRejections: number
  readonly disconnects: number
  readonly reconnects: number
}

export interface HistoryOutcomes {
  readonly xWins: number
  readonly oWins: number
  readonly draws: number
}

export interface HistorySummary {
  readonly from: string
  readonly to: string
  readonly counts: HistoryCounts
  readonly outcomes: HistoryOutcomes
}

export interface HistoryEventsResponse {
  readonly events: readonly HistoryEvent[]
  readonly hasMore: boolean
}
