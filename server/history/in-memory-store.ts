import type { HistoryEvent } from '../../src/history'
import type { HistoryStore, HistoryEventQuery } from './store'
import { summarizeEvents } from './summary'

export class InMemoryHistoryStore implements HistoryStore {
  readonly backend = 'memory' as const
  private readonly events: HistoryEvent[] = []
  private readonly eventIds = new Set<string>()

  async initialize(): Promise<void> {}

  async append(events: readonly HistoryEvent[]): Promise<void> {
    for (const event of events) {
      if (!this.eventIds.has(event.eventId)) {
        this.eventIds.add(event.eventId)
        this.events.push(event)
      }
    }
  }

  async getEvents(
    query: HistoryEventQuery,
  ): Promise<readonly HistoryEvent[]> {
    const fromTime = query.from.getTime()
    const beforeTime = query.before?.getTime() ?? Number.POSITIVE_INFINITY

    return this.events
      .map((event, insertionOrder) => ({ event, insertionOrder }))
      .filter(({ event }) => {
        const eventTime = Date.parse(event.occurredAt)
        return eventTime >= fromTime && eventTime < beforeTime
      })
      .sort(
        (first, second) =>
          Date.parse(second.event.occurredAt) -
            Date.parse(first.event.occurredAt) ||
          second.insertionOrder - first.insertionOrder,
      )
      .slice(0, query.limit)
      .map(({ event }) => event)
  }

  async getSummary(from: Date, to: Date) {
    const fromTime = from.getTime()
    const toTime = to.getTime()
    const events = this.events.filter((event) => {
      const eventTime = Date.parse(event.occurredAt)
      return eventTime >= fromTime && eventTime <= toTime
    })

    return summarizeEvents(events, from, to)
  }

  async close(): Promise<void> {}
}
