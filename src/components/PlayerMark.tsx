import { Circle, X as XIcon } from 'lucide-react'
import type { Player } from '../game/engine'

interface PlayerMarkProps {
  readonly player: Player
  readonly className?: string
}

export function PlayerMark({ player, className = '' }: PlayerMarkProps) {
  const Icon = player === 'X' ? XIcon : Circle
  const classes = [
    'player-mark',
    `player-mark--${player.toLowerCase()}`,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Icon
      aria-hidden="true"
      className={classes}
      focusable="false"
      strokeWidth={1.8}
    />
  )
}
