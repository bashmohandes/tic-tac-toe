export type Player = 'X' | 'O'
export type Cell = Player | null
export type Board = readonly Cell[]
export type WinningLine = readonly [number, number, number]
export type RoundStatus = 'playing' | 'won' | 'draw'

export interface RoundState {
  readonly board: Board
  readonly currentPlayer: Player
  readonly startingPlayer: Player
  readonly status: RoundStatus
  readonly winner: Player | null
  readonly winningLine: WinningLine | null
  readonly moveCount: number
}

export const WINNING_LINES: readonly WinningLine[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

const BOARD_SIZE = 9

export function otherPlayer(player: Player): Player {
  return player === 'X' ? 'O' : 'X'
}

export function createRound(startingPlayer: Player = 'X'): RoundState {
  return {
    board: Array<Cell>(BOARD_SIZE).fill(null),
    currentPlayer: startingPlayer,
    startingPlayer,
    status: 'playing',
    winner: null,
    winningLine: null,
    moveCount: 0,
  }
}

export function getWinningLine(board: Board): WinningLine | null {
  for (const line of WINNING_LINES) {
    const [first, second, third] = line
    const player = board[first]

    if (player && player === board[second] && player === board[third]) {
      return line
    }
  }

  return null
}

export function playMove(state: RoundState, index: number): RoundState {
  const moveIsInvalid =
    !Number.isInteger(index) ||
    index < 0 ||
    index >= BOARD_SIZE ||
    state.status !== 'playing' ||
    state.board[index] !== null

  if (moveIsInvalid) {
    return state
  }

  const board = [...state.board]
  board[index] = state.currentPlayer
  const moveCount = state.moveCount + 1
  const winningLine = getWinningLine(board)

  if (winningLine) {
    return {
      ...state,
      board,
      status: 'won',
      winner: state.currentPlayer,
      winningLine,
      moveCount,
    }
  }

  if (moveCount === BOARD_SIZE) {
    return {
      ...state,
      board,
      status: 'draw',
      moveCount,
    }
  }

  return {
    ...state,
    board,
    currentPlayer: otherPlayer(state.currentPlayer),
    moveCount,
  }
}
