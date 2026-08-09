import { describe, expect, it } from 'vitest'
import {
  createRound,
  getWinningLine,
  playMove,
  WINNING_LINES,
  type Cell,
} from './engine'

describe('tic-tac-toe engine', () => {
  it('creates an empty round with the requested starting player', () => {
    const round = createRound('O')

    expect(round.board).toEqual(Array<Cell>(9).fill(null))
    expect(round.currentPlayer).toBe('O')
    expect(round.status).toBe('playing')
  })

  it('places marks and alternates players', () => {
    const afterX = playMove(createRound(), 4)
    const afterO = playMove(afterX, 0)

    expect(afterX.board[4]).toBe('X')
    expect(afterX.currentPlayer).toBe('O')
    expect(afterO.board[0]).toBe('O')
    expect(afterO.currentPlayer).toBe('X')
  })

  it('rejects occupied and out-of-range squares', () => {
    const afterMove = playMove(createRound(), 4)

    expect(playMove(afterMove, 4)).toBe(afterMove)
    expect(playMove(afterMove, -1)).toBe(afterMove)
    expect(playMove(afterMove, 9)).toBe(afterMove)
  })

  it.each(WINNING_LINES)('detects winning line %s', (...line) => {
    const board = Array<Cell>(9).fill(null)
    line.forEach((index) => {
      board[index] = 'X'
    })

    expect(getWinningLine(board)).toEqual(line)
  })

  it('finishes a round when a player gets three in a row', () => {
    const moves = [0, 3, 1, 4, 2]
    const result = moves.reduce(playMove, createRound())

    expect(result.status).toBe('won')
    expect(result.winner).toBe('X')
    expect(result.winningLine).toEqual([0, 1, 2])
    expect(playMove(result, 8)).toBe(result)
  })

  it('detects a full-board draw', () => {
    const moves = [0, 1, 2, 4, 3, 5, 7, 6, 8]
    const result = moves.reduce(playMove, createRound())

    expect(result.status).toBe('draw')
    expect(result.winner).toBeNull()
    expect(result.moveCount).toBe(9)
  })
})
