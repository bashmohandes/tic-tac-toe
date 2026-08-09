import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ModeSwitcher, type GameMode } from './ModeSwitcher'

function ModeSwitcherHarness() {
  const [mode, setMode] = useState<GameMode>('local')

  return <ModeSwitcher mode={mode} onChange={setMode} />
}

describe('ModeSwitcher', () => {
  it('switches modes with arrow keys', async () => {
    const user = userEvent.setup()
    render(<ModeSwitcherHarness />)
    const localTab = screen.getByRole('tab', { name: 'Local' })

    localTab.focus()
    await user.keyboard('{ArrowRight}')

    const onlineTab = screen.getByRole('tab', { name: 'Online' })
    expect(onlineTab).toHaveFocus()
    expect(onlineTab).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(localTab).toHaveFocus()
    expect(localTab).toHaveAttribute('aria-selected', 'true')
  })
})
