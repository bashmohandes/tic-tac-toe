import { describe, expect, it } from 'vitest'
import {
  createMatchState,
  matchReducer,
  type MatchAction,
  type MatchState,
} from './match'

function reduceActions(actions: readonly MatchAction[]): MatchState {
  return actions.reduce(matchReducer, createMatchState())
}

describe('match reducer', () => {
  it('scores a completed round once', () => {
    const winningMoves: MatchAction[] = [0, 3, 1, 4, 2].map((index) => ({
      type: 'play',
      index,
    }))
    const wonMatch = reduceActions(winningMoves)
    const unchanged = matchReducer(wonMatch, { type: 'play', index: 8 })

    expect(wonMatch.scores.X).toBe(1)
    expect(wonMatch.scores.O).toBe(0)
    expect(unchanged).toBe(wonMatch)
  })

  it('alternates the starting player between completed rounds', () => {
    const drawMoves: MatchAction[] = [0, 1, 2, 4, 3, 5, 7, 6, 8].map(
      (index) => ({
        type: 'play',
        index,
      }),
    )
    const drawnMatch = reduceActions(drawMoves)
    const nextRound = matchReducer(drawnMatch, { type: 'next-round' })

    expect(drawnMatch.scores.draws).toBe(1)
    expect(nextRound.roundNumber).toBe(2)
    expect(nextRound.round.startingPlayer).toBe('O')
    expect(nextRound.round.currentPlayer).toBe('O')
  })

  it('restarts an active round without changing its score', () => {
    const activeMatch = matchReducer(createMatchState(), {
      type: 'play',
      index: 4,
    })
    const restarted = matchReducer(activeMatch, { type: 'restart-round' })

    expect(restarted.round.moveCount).toBe(0)
    expect(restarted.roundNumber).toBe(1)
    expect(restarted.scores).toEqual(activeMatch.scores)
  })

  it('resets the full match', () => {
    const activeMatch = matchReducer(createMatchState(), {
      type: 'play',
      index: 4,
    })

    expect(matchReducer(activeMatch, { type: 'reset-match' })).toEqual(
      createMatchState(),
    )
  })
})
