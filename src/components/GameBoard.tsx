import { useRef, useState, type KeyboardEvent } from 'react'
import type { RoundState } from '../game/engine'
import { PlayerMark } from './PlayerMark'

interface GameBoardProps {
  readonly round: RoundState
  readonly onPlay: (index: number) => void
  readonly canInteract?: boolean
}

const ROWS = [0, 1, 2] as const
const COLUMNS = [0, 1, 2] as const
const CELL_NAMES = [
  'Top left',
  'Top center',
  'Top right',
  'Middle left',
  'Center',
  'Middle right',
  'Bottom left',
  'Bottom center',
  'Bottom right',
] as const

function getNextIndex(index: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return index % 3 === 0 ? index + 2 : index - 1
    case 'ArrowRight':
      return index % 3 === 2 ? index - 2 : index + 1
    case 'ArrowUp':
      return (index + 6) % 9
    case 'ArrowDown':
      return (index + 3) % 9
    case 'Home':
      return 0
    case 'End':
      return 8
    default:
      return null
  }
}

export function GameBoard({
  round,
  onPlay,
  canInteract = true,
}: GameBoardProps) {
  const [focusedIndex, setFocusedIndex] = useState(0)
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([])

  function handleKeyDown(
    index: number,
    event: KeyboardEvent<HTMLButtonElement>,
  ) {
    const nextIndex = getNextIndex(index, event.key)

    if (nextIndex === null) {
      return
    }

    event.preventDefault()
    setFocusedIndex(nextIndex)
    cellRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="game-board" role="grid" aria-label="Tic tac toe board">
      {ROWS.map((row) => (
        <div className="board-row" role="row" key={row}>
          {COLUMNS.map((column) => {
            const index = row * 3 + column
            const cell = round.board[index]
            const isWinningCell =
              round.winningLine?.includes(index) ?? false
            const isPlayable =
              canInteract && round.status === 'playing' && cell === null
            const label = `${CELL_NAMES[index]}, ${cell ?? 'empty'}${
              isWinningCell ? ', winning square' : ''
            }`
            const classes = [
              'board-cell',
              cell ? `board-cell--${cell.toLowerCase()}` : '',
              isWinningCell ? 'board-cell--winning' : '',
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <button
                aria-disabled={!isPlayable}
                aria-label={label}
                className={classes}
                data-playable={isPlayable}
                key={index}
                onClick={() => {
                  if (isPlayable) {
                    onPlay(index)
                  }
                }}
                onFocus={() => setFocusedIndex(index)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                ref={(element) => {
                  cellRefs.current[index] = element
                }}
                role="gridcell"
                tabIndex={focusedIndex === index ? 0 : -1}
                type="button"
              >
                {cell ? (
                  <PlayerMark player={cell} />
                ) : isPlayable ? (
                  <PlayerMark
                    className="player-mark--preview"
                    player={round.currentPlayer}
                  />
                ) : null}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
