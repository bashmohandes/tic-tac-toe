import {
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OnlineLobby } from './OnlineLobby'

const rooms = [
  {
    roomCode: 'ABC234',
    roomName: 'Open table',
    visibility: 'public' as const,
    hostName: 'Alex',
    hostProfile: {
      id: '10000000-0000-4000-8000-000000000001',
      displayName: 'Alex',
      avatarKey: 'coral' as const,
      record: { wins: 8, losses: 4, draws: 2 },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    hostConnected: true,
    playerCount: 1,
    capacity: 2 as const,
  },
  {
    roomCode: 'XYZ789',
    roomName: 'Locked table',
    visibility: 'private' as const,
    hostName: 'Sam',
    hostProfile: {
      id: '10000000-0000-4000-8000-000000000002',
      displayName: 'Sam',
      avatarKey: 'gold' as const,
      record: { wins: 3, losses: 5, draws: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    hostConnected: true,
    playerCount: 1,
    capacity: 2 as const,
  },
]

function renderLobby(
  overrides: Partial<Parameters<typeof OnlineLobby>[0]> = {},
) {
  const props = {
    connectionState: 'lobby' as const,
    error: null,
    initialRoomCode: '',
    isSubmitting: false,
    profile: null,
    rooms,
    onClearError: vi.fn(),
    onCreateRoom: vi.fn(),
    onJoinRoom: vi.fn(),
    onRefreshRooms: vi.fn(),
    ...overrides,
  }

  render(<OnlineLobby {...props} />)
  return props
}

describe('OnlineLobby', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('joins a public room from the directory', async () => {
    const user = userEvent.setup()
    const props = renderLobby()

    await user.click(
      screen.getByRole('button', { name: 'Join Open table' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Open table' })
    await user.type(within(dialog).getByLabelText('Display name'), 'Taylor')
    await user.click(
      within(dialog).getByRole('button', { name: 'Join room' }),
    )

    expect(props.onJoinRoom).toHaveBeenCalledWith(
      'Taylor',
      'ABC234',
      'teal',
      undefined,
    )
  })

  it('collects a password before joining a private room', async () => {
    const user = userEvent.setup()
    const props = renderLobby()

    await user.click(screen.getByRole('tab', { name: /Private/ }))
    await user.click(
      screen.getByRole('button', { name: 'Join Locked table' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Locked table' })
    await user.type(within(dialog).getByLabelText('Display name'), 'Taylor')
    await user.type(
      within(dialog).getByLabelText('Password'),
      'correct-horse',
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Join room' }),
    )

    expect(props.onJoinRoom).toHaveBeenCalledWith(
      'Taylor',
      'XYZ789',
      'teal',
      'correct-horse',
    )
  })

  it('creates a named private room with a password', async () => {
    const user = userEvent.setup()
    const props = renderLobby()

    await user.click(
      screen.getByRole('button', { name: 'Create room' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Create room' })
    await user.type(within(dialog).getByLabelText('Display name'), 'Taylor')
    await user.type(within(dialog).getByLabelText('Room name'), 'Team game')
    await user.click(
      within(dialog).getByRole('button', { name: 'Private' }),
    )
    await user.type(
      within(dialog).getByLabelText('Password'),
      'correct-horse',
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Create room' }),
    )

    expect(props.onCreateRoom).toHaveBeenCalledWith(
      'Taylor',
      'Team game',
      'private',
      'teal',
      'correct-horse',
    )
  })

  it('switches room tabs with arrow keys', async () => {
    const user = userEvent.setup()
    renderLobby()
    const publicTab = screen.getByRole('tab', { name: /Public/ })

    publicTab.focus()
    await user.keyboard('{ArrowRight}')

    const privateTab = screen.getByRole('tab', { name: /Private/ })
    expect(privateTab).toHaveFocus()
    expect(privateTab).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('button', { name: 'Join Locked table' }),
    ).toBeInTheDocument()
  })

  it('closes a dialog with Escape and restores focus', async () => {
    const user = userEvent.setup()
    renderLobby()
    const createButton = screen.getByRole('button', {
      name: 'Create room',
    })

    await user.click(createButton)
    expect(
      screen.getByRole('dialog', { name: 'Create room' }),
    ).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(
      screen.queryByRole('dialog', { name: 'Create room' }),
    ).not.toBeInTheDocument()
    expect(createButton).toHaveFocus()
  })
})
