import { randomUUID } from 'node:crypto'
import {
  HISTORY_SCHEMA_VERSION,
  type HistoryEvent,
  type HistoryEventDraft,
  type HistoryEventsResponse,
  type HistoryPayload,
  type HistorySummary,
  type HistoryValue,
} from '../../src/history'
import type { HistoryStore } from './store'

const DEFAULT_FLUSH_INTERVAL_MS = 250
const MAX_BUFFERED_EVENTS = 10_000
const SENSITIVE_KEYS = new Set([
  'adminapikey',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'databaseurl',
  'hash',
  'password',
  'passwordhash',
  'privatekey',
  'reconnecttoken',
  'roomcode',
  'salt',
  'secret',
  'sessiontoken',
  'socketid',
  'token',
])

interface HistoryRecorderOptions {
  readonly instanceId?: string
  readonly releaseId?: string | null
  readonly flushIntervalMs?: number
  readonly now?: () => Date
}

export type HistoryStatus = 'starting' | 'ready' | 'degraded' | 'closed'

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sanitizeValue(value: HistoryValue): HistoryValue {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }

  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, HistoryValue> = {}

    for (const [key, nestedValue] of Object.entries(value)) {
      if (!SENSITIVE_KEYS.has(normalizedKey(key))) {
        sanitized[key] = sanitizeValue(nestedValue)
      }
    }

    return sanitized
  }

  return value
}

export function sanitizeHistoryPayload(
  payload: HistoryPayload,
): HistoryPayload {
  return sanitizeValue(payload) as HistoryPayload
}

export class HistoryRecorder {
  readonly backend: HistoryStore['backend']
  private readonly store: HistoryStore
  private readonly instanceId: string
  private readonly releaseId: string | null
  private readonly flushIntervalMs: number
  private readonly now: () => Date
  private queue: HistoryEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private initialized = false
  private closed = false
  private currentStatus: HistoryStatus = 'starting'

  constructor(store: HistoryStore, options: HistoryRecorderOptions = {}) {
    this.store = store
    this.backend = store.backend
    this.instanceId = options.instanceId ?? randomUUID()
    this.releaseId = options.releaseId ?? null
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
  }

  get status(): HistoryStatus {
    return this.currentStatus
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.store.initialize()
    this.initialized = true
    this.currentStatus = 'ready'
  }

  record(draft: HistoryEventDraft): void {
    if (this.closed) {
      return
    }

    const event: HistoryEvent = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      type: draft.type,
      roomId: draft.roomId ?? null,
      matchId: draft.matchId ?? null,
      instanceId: this.instanceId,
      releaseId: this.releaseId,
      payload: sanitizeHistoryPayload(draft.payload ?? {}),
      schemaVersion: HISTORY_SCHEMA_VERSION,
    }

    this.queue.push(event)

    if (this.queue.length > MAX_BUFFERED_EVENTS) {
      this.queue.splice(0, this.queue.length - MAX_BUFFERED_EVENTS)
      console.error('History buffer reached its limit; oldest events dropped.')
    }

    if (this.queue.length >= 100) {
      void this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  async flush(): Promise<void> {
    this.clearTimer()
    this.writeChain = this.writeChain.then(async () => {
      if (!this.initialized) {
        return
      }

      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 100)

        try {
          await this.store.append(batch)
          this.currentStatus = 'ready'
        } catch (error) {
          this.queue.unshift(...batch)
          this.currentStatus = 'degraded'
          console.error('History write failed; events remain buffered.', error)
          break
        }
      }

      if (this.queue.length > 0 && !this.closed) {
        this.scheduleFlush(
          this.currentStatus === 'degraded' ? 2_000 : this.flushIntervalMs,
        )
      }
    })

    await this.writeChain
  }

  async getSummary(hours: number): Promise<HistorySummary> {
    await this.flush()
    const to = this.now()
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000)
    return this.store.getSummary(from, to)
  }

  async getEvents(
    hours: number,
    limit: number,
    before?: Date,
  ): Promise<HistoryEventsResponse> {
    await this.flush()
    const to = this.now()
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000)
    const events = await this.store.getEvents({
      from,
      before,
      limit: limit + 1,
    })

    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit,
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.clearTimer()
    await this.flush()
    this.closed = true
    this.clearTimer()
    this.currentStatus = 'closed'
    await this.store.close()
  }

  private scheduleFlush(delay = this.flushIntervalMs): void {
    if (this.timer || this.closed) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
