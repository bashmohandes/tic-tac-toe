import { useCallback, useMemo, useReducer } from 'react'
import {
  createMatchState,
  matchReducer,
  type MatchState,
} from './match'

export interface GameSession {
  readonly state: MatchState
  readonly canPlay: boolean
  readonly canRestartRound: boolean
  readonly canNextRound: boolean
  readonly canResetMatch: boolean
  readonly play: (index: number) => void
  readonly restartRound: () => void
  readonly nextRound: () => void
  readonly resetMatch: () => void
}

export function useLocalGameSession(): GameSession {
  const [state, dispatch] = useReducer(matchReducer, null, createMatchState)

  const play = useCallback((index: number) => {
    dispatch({ type: 'play', index })
  }, [])

  const restartRound = useCallback(() => {
    dispatch({ type: 'restart-round' })
  }, [])

  const nextRound = useCallback(() => {
    dispatch({ type: 'next-round' })
  }, [])

  const resetMatch = useCallback(() => {
    dispatch({ type: 'reset-match' })
  }, [])

  return useMemo(
    () => ({
      state,
      canPlay: true,
      canRestartRound:
        state.round.status === 'playing' && state.round.moveCount > 0,
      canNextRound: state.round.status !== 'playing',
      canResetMatch: true,
      play,
      restartRound,
      nextRound,
      resetMatch,
    }),
    [nextRound, play, resetMatch, restartRound, state],
  )
}
