import type {
  HistoryEvent,
  HistorySummary,
} from '../../src/history'

export function summarizeEvents(
  events: readonly HistoryEvent[],
  from: Date,
  to: Date,
): HistorySummary {
  const counts = {
    roomsCreated: 0,
    matchesStarted: 0,
    roundsCompleted: 0,
    movesPlayed: 0,
    playersJoined: 0,
    joinRejections: 0,
    disconnects: 0,
    reconnects: 0,
  }
  const outcomes = {
    xWins: 0,
    oWins: 0,
    draws: 0,
  }

  for (const event of events) {
    switch (event.type) {
      case 'room_created':
        counts.roomsCreated += 1
        break
      case 'match_started':
        counts.matchesStarted += 1
        break
      case 'round_completed':
        counts.roundsCompleted += 1
        if (event.payload.outcome === 'X') {
          outcomes.xWins += 1
        } else if (event.payload.outcome === 'O') {
          outcomes.oWins += 1
        } else if (event.payload.outcome === 'draw') {
          outcomes.draws += 1
        }
        break
      case 'move_played':
        counts.movesPlayed += 1
        break
      case 'player_joined':
        counts.playersJoined += 1
        break
      case 'join_rejected':
        counts.joinRejections += 1
        break
      case 'player_disconnected':
        counts.disconnects += 1
        break
      case 'player_reconnected':
        counts.reconnects += 1
        break
      default:
        break
    }
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    counts,
    outcomes,
  }
}
