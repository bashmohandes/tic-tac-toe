import type {
  HistoryEvent,
  HistorySummary,
} from '../../src/history'

export interface HistoryEventQuery {
  readonly from: Date
  readonly before?: Date
  readonly limit: number
}

export interface HistoryStore {
  readonly backend: 'memory' | 'postgres'
  initialize(): Promise<void>
  append(events: readonly HistoryEvent[]): Promise<void>
  getEvents(query: HistoryEventQuery): Promise<readonly HistoryEvent[]>
  getSummary(from: Date, to: Date): Promise<HistorySummary>
  close(): Promise<void>
}
