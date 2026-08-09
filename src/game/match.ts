import {
  createRound,
  otherPlayer,
  playMove,
  type Player,
  type RoundState,
} from './engine'

export interface MatchScores {
  readonly X: number
  readonly O: number
  readonly draws: number
}

export interface MatchState {
  readonly round: RoundState
  readonly roundNumber: number
  readonly scores: MatchScores
}

export type MatchAction =
  | { readonly type: 'play'; readonly index: number }
  | { readonly type: 'restart-round' }
  | { readonly type: 'next-round' }
  | { readonly type: 'reset-match' }

export function createMatchState(): MatchState {
  return {
    round: createRound(),
    roundNumber: 1,
    scores: {
      X: 0,
      O: 0,
      draws: 0,
    },
  }
}

function scoreCompletedRound(
  scores: MatchScores,
  round: RoundState,
): MatchScores {
  if (round.status === 'draw') {
    return {
      ...scores,
      draws: scores.draws + 1,
    }
  }

  if (round.status === 'won' && round.winner) {
    return {
      ...scores,
      [round.winner]: scores[round.winner] + 1,
    }
  }

  return scores
}

function createNextRound(state: MatchState): MatchState {
  const nextStarter: Player = otherPlayer(state.round.startingPlayer)

  return {
    ...state,
    round: createRound(nextStarter),
    roundNumber: state.roundNumber + 1,
  }
}

export function matchReducer(
  state: MatchState,
  action: MatchAction,
): MatchState {
  switch (action.type) {
    case 'play': {
      const round = playMove(state.round, action.index)

      if (round === state.round) {
        return state
      }

      return {
        ...state,
        round,
        scores:
          round.status === 'playing'
            ? state.scores
            : scoreCompletedRound(state.scores, round),
      }
    }

    case 'restart-round':
      if (state.round.status !== 'playing' || state.round.moveCount === 0) {
        return state
      }

      return {
        ...state,
        round: createRound(state.round.startingPlayer),
      }

    case 'next-round':
      return state.round.status === 'playing' ? state : createNextRound(state)

    case 'reset-match':
      return createMatchState()
  }
}
