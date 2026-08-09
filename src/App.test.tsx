import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('tic-tac-toe app', () => {
  it('plays a round, scores the winner, and starts the next round', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('gridcell', { name: /top left, empty/i }),
    )
    await user.click(
      screen.getByRole('gridcell', { name: /middle left, empty/i }),
    )
    await user.click(
      screen.getByRole('gridcell', { name: /top center, empty/i }),
    )
    await user.click(
      screen.getByRole('gridcell', { name: /^center, empty$/i }),
    )
    await user.click(
      screen.getByRole('gridcell', { name: /top right, empty/i }),
    )

    expect(
      screen.getByRole('heading', { name: 'Crosses win' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Crosses: 1 point')).toHaveTextContent('1')

    await user.click(screen.getByRole('button', { name: 'Next round' }))

    expect(
      screen.getByRole('heading', { name: 'Circles to move' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Crosses: 1 point')).toHaveTextContent('1')
  })

  it('supports arrow-key board navigation and keyboard moves', async () => {
    const user = userEvent.setup()
    render(<App />)

    const topLeft = screen.getByRole('gridcell', {
      name: /top left, empty/i,
    })
    topLeft.focus()

    await user.keyboard('{ArrowRight}{Enter}')

    expect(
      screen.getByRole('gridcell', { name: /top center, X/i }),
    ).toHaveFocus()
  })

  it('restarts an active round without changing the match score', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(
      screen.getByRole('gridcell', { name: /^center, empty$/i }),
    )
    await user.click(screen.getByRole('button', { name: 'Restart round' }))

    expect(
      screen.getByRole('gridcell', { name: /^center, empty$/i }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Crosses: 0 points')).toHaveTextContent('0')
  })
})
