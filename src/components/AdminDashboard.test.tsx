import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import type {
  HistoryEventsResponse,
  HistorySummary,
} from '../history'

const summary: HistorySummary = {
  from: '2026-08-07T18:00:00.000Z',
  to: '2026-08-08T18:00:00.000Z',
  counts: {
    roomsCreated: 3,
    matchesStarted: 2,
    roundsCompleted: 4,
    movesPlayed: 23,
    playersJoined: 5,
    joinRejections: 1,
    disconnects: 2,
    reconnects: 1,
  },
  outcomes: {
    xWins: 2,
    oWins: 1,
    draws: 1,
  },
}

const eventResponse: HistoryEventsResponse = {
  hasMore: false,
  events: [
    {
      eventId: '5ea8d09d-83c9-451a-8963-e531901cd573',
      occurredAt: '2026-08-08T18:00:00.000Z',
      type: 'round_completed',
      roomId: 'e07f916e-00dd-48ca-9c35-7617ec6835ce',
      matchId: 'a33b8807-753d-43d6-8d65-f05474176f4a',
      instanceId: 'test-instance',
      releaseId: 'test-release',
      payload: {
        outcome: 'X',
        roundNumber: 2,
      },
      schemaVersion: 1,
    },
  ],
}

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.history.pushState({}, '', '/')
})

describe('AdminDashboard', () => {
  it('authenticates in session storage and renders history', async () => {
    window.history.pushState({}, '', '/admin')
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const body = url.includes('/summary') ? summary : eventResponse

      return {
        ok: true,
        json: async () => body,
      } as Response
    })
    const user = userEvent.setup()

    render(<App />)
    await user.type(
      screen.getByLabelText('Operator key'),
      'operator-test-key',
    )
    await user.click(
      screen.getByRole('button', { name: 'Open history' }),
    )

    expect(
      await screen.findByRole('heading', { name: 'Match activity' }),
    ).toBeInTheDocument()
    expect(screen.getByText('23')).toBeInTheDocument()
    expect(screen.getByText('Round Completed')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('tic-tac-toe:operator-key')).toBe(
      'operator-test-key',
    )
    await waitFor(() => expect(window.fetch).toHaveBeenCalledTimes(2))
  })
})
