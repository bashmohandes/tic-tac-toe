import {
  useRef,
  type KeyboardEvent,
} from 'react'
import { Monitor, Wifi } from 'lucide-react'

export type GameMode = 'local' | 'online'

interface ModeSwitcherProps {
  readonly mode: GameMode
  readonly onChange: (mode: GameMode) => void
}

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  const localTabRef = useRef<HTMLButtonElement>(null)
  const onlineTabRef = useRef<HTMLButtonElement>(null)

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    let nextMode: GameMode | null = null

    if (event.key === 'ArrowLeft' || event.key === 'Home') {
      nextMode = 'local'
    } else if (event.key === 'ArrowRight' || event.key === 'End') {
      nextMode = 'online'
    }

    if (!nextMode) {
      return
    }

    event.preventDefault()
    onChange(nextMode)

    if (nextMode === 'local') {
      localTabRef.current?.focus()
    } else {
      onlineTabRef.current?.focus()
    }
  }

  return (
    <div className="mode-switcher" role="tablist" aria-label="Game mode">
      <button
        aria-controls="game-surface"
        aria-selected={mode === 'local'}
        onClick={() => onChange('local')}
        onKeyDown={handleKeyDown}
        ref={localTabRef}
        role="tab"
        tabIndex={mode === 'local' ? 0 : -1}
        type="button"
      >
        <Monitor aria-hidden="true" />
        Local
      </button>
      <button
        aria-controls="game-surface"
        aria-selected={mode === 'online'}
        onClick={() => onChange('online')}
        onKeyDown={handleKeyDown}
        ref={onlineTabRef}
        role="tab"
        tabIndex={mode === 'online' ? 0 : -1}
        type="button"
      >
        <Wifi aria-hidden="true" />
        Online
      </button>
    </div>
  )
}
