import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'
import {
  Activity,
  ArrowLeft,
  Database,
  Grid3X3,
  KeyRound,
  LogOut,
  RefreshCw,
} from 'lucide-react'
import type {
  HistoryEvent,
  HistoryEventsResponse,
  HistorySummary,
  HistoryValue,
} from '../history'

const ADMIN_KEY_STORAGE = 'tic-tac-toe:operator-key'
const REPORTING_WINDOWS = [
  { hours: 24, label: '24 hours' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
] as const

interface ApiErrorBody {
  readonly error?: string
}

function storedOperatorKey(): string {
  try {
    return window.sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

function persistOperatorKey(key: string): void {
  try {
    if (key) {
      window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key)
    } else {
      window.sessionStorage.removeItem(ADMIN_KEY_STORAGE)
    }
  } catch {
    // Session storage can be unavailable in privacy-restricted browsers.
  }
}

async function fetchHistory<T>(
  path: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    headers: {
      'x-admin-api-key': apiKey,
    },
    signal,
  })

  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({}))) as ApiErrorBody
    throw new Error(body.error ?? 'History is unavailable.')
  }

  return (await response.json()) as T
}

function labelForEvent(event: HistoryEvent): string {
  return event.type
    .split('_')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function displayValue(value: HistoryValue | undefined): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  return null
}

function reasonLabel(value: HistoryValue | undefined): string | null {
  const reason = displayValue(value)
  return reason?.replaceAll('_', ' ') ?? null
}

function eventDetail(event: HistoryEvent): string {
  const name = displayValue(event.payload.name)
  const mark = displayValue(event.payload.mark)
  const round = displayValue(event.payload.roundNumber)

  switch (event.type) {
    case 'profile_created':
    case 'profile_updated':
      return [
        displayValue(event.payload.displayName),
        displayValue(event.payload.avatarKey),
      ]
        .filter(Boolean)
        .join(' / ')
    case 'service_started':
      return `History: ${
        displayValue(event.payload.historyBackend) ?? 'unknown'
      }`
    case 'service_stopped':
      return `${
        displayValue(event.payload.uptimeSeconds) ?? '0'
      }s uptime`
    case 'room_created':
      return [
        displayValue(event.payload.roomName),
        displayValue(event.payload.visibility),
      ]
        .filter(Boolean)
        .join(' / ')
    case 'room_recovered':
      return `${
        displayValue(event.payload.playerCount) ?? '0'
      } players / revision ${
        displayValue(event.payload.revision) ?? '0'
      }`
    case 'player_joined':
    case 'player_disconnected':
    case 'player_reconnected':
      return [name, mark].filter(Boolean).join(' / ')
    case 'player_left':
      return [name, reasonLabel(event.payload.reason)]
        .filter(Boolean)
        .join(' / ')
    case 'match_started':
    case 'round_started':
      return round ? `Round ${round}` : ''
    case 'move_played':
      return `${mark ?? '?'} played square ${
        displayValue(event.payload.index) ?? '?'
      }${round ? ` / round ${round}` : ''}`
    case 'round_completed':
      return `${
        displayValue(event.payload.outcome) ?? 'unknown'
      } / round ${round ?? '?'}`
    case 'join_rejected':
    case 'match_ended':
    case 'room_closed':
      return reasonLabel(event.payload.reason) ?? ''
  }
}

function shortId(value: string | null): string {
  return value?.slice(0, 8) ?? '-'
}

function Metric({
  label,
  value,
}: {
  readonly label: string
  readonly value: number
}) {
  return (
    <div className="history-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  )
}

export function AdminDashboard() {
  const [apiKey, setApiKey] = useState(storedOperatorKey)
  const [draftKey, setDraftKey] = useState('')
  const [hours, setHours] = useState(24)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [summary, setSummary] = useState<HistorySummary | null>(null)
  const [events, setEvents] = useState<readonly HistoryEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!apiKey) {
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    void Promise.all([
      fetchHistory<HistorySummary>(
        `/api/admin/history/summary?hours=${hours}`,
        apiKey,
        controller.signal,
      ),
      fetchHistory<HistoryEventsResponse>(
        `/api/admin/history/events?hours=${hours}&limit=100`,
        apiKey,
        controller.signal,
      ),
    ])
      .then(([nextSummary, eventResponse]) => {
        setSummary(nextSummary)
        setEvents(eventResponse.events)
      })
      .catch((requestError: unknown) => {
        if (
          requestError instanceof DOMException &&
          requestError.name === 'AbortError'
        ) {
          return
        }

        const message =
          requestError instanceof Error
            ? requestError.message
            : 'History is unavailable.'
        setError(message)

        if (message === 'Invalid operator key.') {
          persistOperatorKey('')
          setApiKey('')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      })

    return () => controller.abort()
  }, [apiKey, hours, refreshVersion])

  function submitKey(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const nextKey = draftKey.trim()

    if (!nextKey) {
      setError('Enter an operator key.')
      return
    }

    persistOperatorKey(nextKey)
    setApiKey(nextKey)
    setDraftKey('')
  }

  function signOut(): void {
    persistOperatorKey('')
    setApiKey('')
    setSummary(null)
    setEvents([])
    setError(null)
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <a className="brand" href="/" aria-label="Return to Tic Tac Toe">
          <span className="brand-icon">
            <Grid3X3 aria-hidden="true" strokeWidth={1.8} />
          </span>
          <span>Tic Tac Toe</span>
        </a>

        <span className="admin-header-label">Operations</span>

        <div className="admin-header-actions">
          {apiKey ? (
            <>
              <button
                aria-label="Refresh history"
                className="icon-button"
                data-tooltip="Refresh"
                disabled={loading}
                onClick={() => setRefreshVersion((version) => version + 1)}
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={loading ? 'loading-icon' : undefined}
                />
              </button>
              <button
                aria-label="End operator session"
                className="icon-button"
                data-tooltip="Sign out"
                onClick={signOut}
                type="button"
              >
                <LogOut aria-hidden="true" />
              </button>
            </>
          ) : (
            <a
              aria-label="Return to game"
              className="icon-button"
              data-tooltip="Back to game"
              href="/"
            >
              <ArrowLeft aria-hidden="true" />
            </a>
          )}
        </div>
      </header>

      {!apiKey ? (
        <main className="admin-login">
          <section aria-labelledby="admin-login-title">
            <span className="admin-login-icon">
              <KeyRound aria-hidden="true" strokeWidth={1.8} />
            </span>
            <p className="eyebrow">Restricted access</p>
            <h1 id="admin-login-title">Match history</h1>
            <form onSubmit={submitKey}>
              <label className="form-field">
                <span>Operator key</span>
                <input
                  autoComplete="current-password"
                  onChange={(event) => setDraftKey(event.target.value)}
                  type="password"
                  value={draftKey}
                />
              </label>
              {error ? (
                <p className="admin-inline-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                className="action-button action-button--primary"
                type="submit"
              >
                Open history
              </button>
            </form>
          </section>
        </main>
      ) : (
        <main className="history-dashboard">
          <div className="history-title-row">
            <div>
              <p className="eyebrow">Deployment history</p>
              <h1>Match activity</h1>
              <p>
                {summary
                  ? `${new Date(summary.from).toLocaleString()} to ${new Date(
                      summary.to,
                    ).toLocaleString()}`
                  : 'Loading report'}
              </p>
            </div>
            <div
              aria-label="Reporting window"
              className="history-window"
              role="group"
            >
              {REPORTING_WINDOWS.map((window) => (
                <button
                  aria-pressed={hours === window.hours}
                  key={window.hours}
                  onClick={() => setHours(window.hours)}
                  type="button"
                >
                  {window.label}
                </button>
              ))}
            </div>
          </div>

          {error ? (
            <p className="history-error" role="alert">
              {error}
            </p>
          ) : null}

          <section
            aria-label="Activity summary"
            className="history-metrics"
          >
            <Metric
              label="Rooms created"
              value={summary?.counts.roomsCreated ?? 0}
            />
            <Metric
              label="Matches started"
              value={summary?.counts.matchesStarted ?? 0}
            />
            <Metric
              label="Rounds completed"
              value={summary?.counts.roundsCompleted ?? 0}
            />
            <Metric
              label="Moves played"
              value={summary?.counts.movesPlayed ?? 0}
            />
            <Metric
              label="Players joined"
              value={summary?.counts.playersJoined ?? 0}
            />
            <Metric
              label="Join rejections"
              value={summary?.counts.joinRejections ?? 0}
            />
            <Metric
              label="Disconnects"
              value={summary?.counts.disconnects ?? 0}
            />
            <Metric
              label="Reconnects"
              value={summary?.counts.reconnects ?? 0}
            />
          </section>

          <section className="history-outcomes" aria-labelledby="outcomes-title">
            <div>
              <Activity aria-hidden="true" />
              <div>
                <p className="eyebrow">Completed rounds</p>
                <h2 id="outcomes-title">Outcomes</h2>
              </div>
            </div>
            <dl>
              <div>
                <dt>X wins</dt>
                <dd>{summary?.outcomes.xWins ?? 0}</dd>
              </div>
              <div>
                <dt>O wins</dt>
                <dd>{summary?.outcomes.oWins ?? 0}</dd>
              </div>
              <div>
                <dt>Draws</dt>
                <dd>{summary?.outcomes.draws ?? 0}</dd>
              </div>
            </dl>
          </section>

          <section className="history-events" aria-labelledby="events-title">
            <div className="history-section-heading">
              <div>
                <p className="eyebrow">Most recent 100</p>
                <h2 id="events-title">Event log</h2>
              </div>
              <Database aria-hidden="true" />
            </div>

            <div className="history-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Room</th>
                    <th>Match</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length > 0 ? (
                    events.map((event) => (
                      <tr key={event.eventId}>
                        <td>
                          <time dateTime={event.occurredAt}>
                            {new Date(event.occurredAt).toLocaleString()}
                          </time>
                        </td>
                        <td>{labelForEvent(event)}</td>
                        <td className="history-id">
                          {shortId(event.roomId)}
                        </td>
                        <td className="history-id">
                          {shortId(event.matchId)}
                        </td>
                        <td>{eventDetail(event)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="history-empty" colSpan={5}>
                        {loading
                          ? 'Loading events'
                          : 'No events in this window'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      )}
    </div>
  )
}
