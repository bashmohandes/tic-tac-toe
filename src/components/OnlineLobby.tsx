import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  AlertCircle,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Users,
  X,
} from 'lucide-react'
import { profileRecordLabel } from '../game/profile-display'
import { ProfileAvatar } from './ProfileAvatar'
import type {
  OnlineConnectionState,
} from '../game/remote-session'
import type {
  PlayerAvatarKey,
  PublicPlayerProfile,
  RoomDirectoryEntry,
  RoomVisibility,
} from '../game/protocol'
import { PLAYER_AVATAR_KEYS } from '../game/protocol'

const GUEST_NAME_KEY = 'tic-tac-toe:guest-name'

interface OnlineLobbyProps {
  readonly connectionState: OnlineConnectionState
  readonly error: string | null
  readonly initialRoomCode: string
  readonly isSubmitting: boolean
  readonly profile: PublicPlayerProfile | null
  readonly rooms: readonly RoomDirectoryEntry[]
  readonly onClearError: () => void
  readonly onCreateRoom: (
    name: string,
    roomName: string,
    visibility: RoomVisibility,
    avatarKey: PlayerAvatarKey,
    password?: string,
  ) => void
  readonly onJoinRoom: (
    name: string,
    roomCode: string,
    avatarKey: PlayerAvatarKey,
    password?: string,
  ) => void
  readonly onRefreshRooms: () => void
}

function readGuestName(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(GUEST_NAME_KEY) ?? ''
}

function saveGuestName(name: string): void {
  if (name) {
    window.localStorage.setItem(GUEST_NAME_KEY, name)
  }
}

function AvatarPicker({
  name,
  onChange,
  value,
}: {
  readonly name: string
  readonly onChange: (avatarKey: PlayerAvatarKey) => void
  readonly value: PlayerAvatarKey
}) {
  return (
    <fieldset className="avatar-picker">
      <legend>Profile color</legend>
      <div>
        {PLAYER_AVATAR_KEYS.map((color) => (
          <button
            aria-label={`Use ${color} profile color`}
            aria-pressed={value === color}
            key={color}
            onClick={() => onChange(color)}
            type="button"
          >
            <ProfileAvatar
              avatarKey={color}
              name={name || 'Player'}
            />
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function OnlineLobby({
  connectionState,
  error,
  initialRoomCode,
  isSubmitting,
  profile,
  rooms,
  onClearError,
  onCreateRoom,
  onJoinRoom,
  onRefreshRooms,
}: OnlineLobbyProps) {
  const [activeTab, setActiveTab] =
    useState<RoomVisibility>('public')
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedRoom, setSelectedRoom] =
    useState<RoomDirectoryEntry | null>(null)
  const [name, setName] = useState(
    () => profile?.displayName ?? readGuestName(),
  )
  const [avatarKey, setAvatarKey] = useState<PlayerAvatarKey>(
    profile?.avatarKey ?? 'teal',
  )
  const [roomName, setRoomName] = useState('')
  const [visibility, setVisibility] =
    useState<RoomVisibility>('public')
  const [createPassword, setCreatePassword] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const handledInviteRef = useRef(false)
  const publicTabRef = useRef<HTMLButtonElement>(null)
  const privateTabRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const clearErrorRef = useRef(onClearError)
  const isConnecting = connectionState === 'connecting'
  const isBusy = isConnecting || isSubmitting
  const dialogOpen = createOpen || selectedRoom !== null
  const visibleRooms = rooms.filter(
    (room) => room.visibility === activeTab,
  )
  const publicCount = rooms.filter(
    (room) => room.visibility === 'public',
  ).length
  const privateCount = rooms.length - publicCount

  useEffect(() => {
    clearErrorRef.current = onClearError
  }, [onClearError])

  useEffect(() => {
    if (profile && !dialogOpen) {
      setName(profile.displayName)
      setAvatarKey(profile.avatarKey)
    }
  }, [dialogOpen, profile])

  useEffect(() => {
    if (!initialRoomCode || handledInviteRef.current) {
      return
    }

    const invitedRoom = rooms.find(
      (room) => room.roomCode === initialRoomCode,
    )

    if (invitedRoom) {
      handledInviteRef.current = true
      setActiveTab(invitedRoom.visibility)
      setSelectedRoom(invitedRoom)
    }
  }, [initialRoomCode, rooms])

  useEffect(() => {
    if (!dialogOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow

    document.body.style.overflow = 'hidden'

    function dismissDialog(): void {
      setCreateOpen(false)
      setSelectedRoom(null)
      setCreatePassword('')
      setJoinPassword('')
      clearErrorRef.current()
    }

    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissDialog()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusableElements = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ),
      ].filter((element) => element.tabIndex >= 0)
      const firstElement = focusableElements[0]
      const lastElement = focusableElements.at(-1)

      if (!firstElement || !lastElement) {
        event.preventDefault()
        return
      }

      if (
        event.shiftKey &&
        (document.activeElement === firstElement ||
          !dialogRef.current.contains(document.activeElement))
      ) {
        event.preventDefault()
        lastElement.focus()
      } else if (
        !event.shiftKey &&
        document.activeElement === lastElement
      ) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener('keydown', handleDocumentKeyDown)

    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown)
      document.body.style.overflow = previousOverflow

      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus()
      }
      returnFocusRef.current = null
    }
  }, [dialogOpen])

  function closeDialogs(): void {
    setCreateOpen(false)
    setSelectedRoom(null)
    setCreatePassword('')
    setJoinPassword('')
    onClearError()
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void {
    let nextTab: RoomVisibility | null = null

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextTab = activeTab === 'public' ? 'private' : 'public'
    } else if (event.key === 'Home') {
      nextTab = 'public'
    } else if (event.key === 'End') {
      nextTab = 'private'
    }

    if (!nextTab) {
      return
    }

    event.preventDefault()
    setActiveTab(nextTab)

    if (nextTab === 'public') {
      publicTabRef.current?.focus()
    } else {
      privateTabRef.current?.focus()
    }
  }

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmedName = name.trim()
    saveGuestName(trimmedName)
    onCreateRoom(
      trimmedName,
      roomName.trim(),
      visibility,
      avatarKey,
      visibility === 'private' ? createPassword : undefined,
    )
  }

  function handleJoin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    if (!selectedRoom) {
      return
    }

    const trimmedName = name.trim()
    saveGuestName(trimmedName)
    onJoinRoom(
      trimmedName,
      selectedRoom.roomCode,
      avatarKey,
      selectedRoom.visibility === 'private' ? joinPassword : undefined,
    )
  }

  function renderError() {
    if (!error) {
      return null
    }

    return (
      <div className="form-error" role="alert">
        <AlertCircle aria-hidden="true" />
        <span>{error}</span>
        <button
          aria-label="Dismiss error"
          onClick={onClearError}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <main className="online-lobby online-directory" id="game-surface">
      <div className="directory-heading">
        <div>
          <p className="eyebrow">Online match</p>
          <h1>Room directory</h1>
          <p>
            {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} active
          </p>
        </div>
        <div className="directory-actions">
          {profile ? (
            <div className="lobby-profile">
              <ProfileAvatar
                name={profile.displayName}
                profile={profile}
              />
              <span>
                <strong>{profile.displayName}</strong>
                <small>{profileRecordLabel(profile)}</small>
              </span>
            </div>
          ) : null}
          <button
            className="action-button action-button--primary create-room-button"
            disabled={isConnecting}
            onClick={() => {
              returnFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null
              onClearError()
              setCreateOpen(true)
            }}
            type="button"
          >
            <Plus aria-hidden="true" />
            Create room
          </button>
        </div>
      </div>

      <div className="directory-tabs">
        <div role="tablist" aria-label="Room visibility">
          <button
            aria-controls="room-list"
            aria-selected={activeTab === 'public'}
            id="public-room-tab"
            onClick={() => setActiveTab('public')}
            onKeyDown={handleTabKeyDown}
            ref={publicTabRef}
            role="tab"
            tabIndex={activeTab === 'public' ? 0 : -1}
            type="button"
          >
            <Globe2 aria-hidden="true" />
            Public
            <span>{publicCount}</span>
          </button>
          <button
            aria-controls="room-list"
            aria-selected={activeTab === 'private'}
            id="private-room-tab"
            onClick={() => setActiveTab('private')}
            onKeyDown={handleTabKeyDown}
            ref={privateTabRef}
            role="tab"
            tabIndex={activeTab === 'private' ? 0 : -1}
            type="button"
          >
            <LockKeyhole aria-hidden="true" />
            Private
            <span>{privateCount}</span>
          </button>
        </div>
        <button
          aria-label="Refresh rooms"
          className="directory-refresh"
          data-tooltip="Refresh rooms"
          disabled={isConnecting}
          onClick={onRefreshRooms}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={isConnecting ? 'loading-icon' : ''}
          />
        </button>
      </div>

      {!createOpen && !selectedRoom ? renderError() : null}

      <section
        aria-label={`${activeTab === 'public' ? 'Public' : 'Private'} rooms`}
        aria-labelledby={`${activeTab}-room-tab`}
        className="room-list"
        id="room-list"
        role="tabpanel"
      >
        {isConnecting ? (
          <div className="directory-empty">
            <LoaderCircle aria-hidden="true" className="loading-icon" />
            <strong>Connecting</strong>
          </div>
        ) : visibleRooms.length === 0 ? (
          <div className="directory-empty">
            {activeTab === 'public' ? (
              <Globe2 aria-hidden="true" />
            ) : (
              <LockKeyhole aria-hidden="true" />
            )}
            <strong>No {activeTab} rooms open</strong>
          </div>
        ) : (
          visibleRooms.map((room) => {
            const isFull = room.playerCount >= room.capacity
            const isUnavailable = isFull || !room.hostConnected

            return (
              <article className="room-row" key={room.roomCode}>
                <span className="room-host-avatar">
                  <ProfileAvatar
                    name={room.hostProfile.displayName}
                    profile={room.hostProfile}
                  />
                  <span className="room-privacy-badge">
                    {room.visibility === 'private' ? (
                      <LockKeyhole aria-hidden="true" />
                    ) : (
                      <Globe2 aria-hidden="true" />
                    )}
                  </span>
                </span>
                <div className="room-details">
                  <h2>{room.roomName}</h2>
                  <p>
                    Hosted by {room.hostName}
                    <span aria-hidden="true"> / </span>
                    {profileRecordLabel(room.hostProfile)}
                  </p>
                </div>
                <span className="room-occupancy">
                  <Users aria-hidden="true" />
                  {room.playerCount}/{room.capacity}
                </span>
                <button
                  aria-label={
                    isFull
                      ? `${room.roomName} is full`
                      : room.hostConnected
                        ? `Join ${room.roomName}`
                        : `${room.roomName} host is offline`
                  }
                  className="room-join-button"
                  disabled={isUnavailable}
                  onClick={() => {
                    returnFocusRef.current =
                      document.activeElement instanceof HTMLElement
                        ? document.activeElement
                        : null
                    onClearError()
                    setJoinPassword('')
                    setSelectedRoom(room)
                  }}
                  type="button"
                >
                  {isFull
                    ? 'Full'
                    : room.hostConnected
                      ? 'Join'
                      : 'Host offline'}
                </button>
              </article>
            )
          })
        )}
      </section>

      {createOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDialogs()
            }
          }}
        >
          <section
            aria-labelledby="create-room-title"
            aria-modal="true"
            className="room-dialog"
            ref={dialogRef}
            role="dialog"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">New match</p>
                <h2 id="create-room-title">Create room</h2>
              </div>
              <button
                aria-label="Close"
                onClick={closeDialogs}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <form className="dialog-form" onSubmit={handleCreate}>
              <label className="form-field">
                <span>Display name</span>
                <input
                  autoComplete="nickname"
                  autoFocus
                  maxLength={24}
                  onChange={(event) => {
                    setName(event.target.value)
                    onClearError()
                  }}
                  placeholder="Your name"
                  required
                  value={name}
                />
              </label>
              <AvatarPicker
                name={name}
                onChange={(nextAvatar) => {
                  setAvatarKey(nextAvatar)
                  onClearError()
                }}
                value={avatarKey}
              />
              <label className="form-field">
                <span>Room name</span>
                <input
                  autoComplete="off"
                  maxLength={32}
                  onChange={(event) => {
                    setRoomName(event.target.value)
                    onClearError()
                  }}
                  placeholder="Friday game"
                  required
                  value={roomName}
                />
              </label>

              <fieldset className="visibility-field">
                <legend>Visibility</legend>
                <div>
                  <button
                    aria-pressed={visibility === 'public'}
                    onClick={() => {
                      setVisibility('public')
                      onClearError()
                    }}
                    type="button"
                  >
                    <Globe2 aria-hidden="true" />
                    Public
                  </button>
                  <button
                    aria-pressed={visibility === 'private'}
                    onClick={() => {
                      setVisibility('private')
                      onClearError()
                    }}
                    type="button"
                  >
                    <LockKeyhole aria-hidden="true" />
                    Private
                  </button>
                </div>
              </fieldset>

              {visibility === 'private' ? (
                <label className="form-field">
                  <span>Password</span>
                  <input
                    autoComplete="new-password"
                    maxLength={64}
                    minLength={6}
                    onChange={(event) => {
                      setCreatePassword(event.target.value)
                      onClearError()
                    }}
                    placeholder="At least 6 characters"
                    required
                    type="password"
                    value={createPassword}
                  />
                </label>
              ) : null}

              {renderError()}

              <button
                className="action-button action-button--primary"
                disabled={isBusy}
                type="submit"
              >
                {isBusy ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="loading-icon"
                  />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                Create room
              </button>
            </form>
          </section>
        </div>
      ) : null}

      {selectedRoom ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDialogs()
            }
          }}
        >
          <section
            aria-labelledby="join-room-title"
            aria-modal="true"
            className="room-dialog"
            ref={dialogRef}
            role="dialog"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">
                  {selectedRoom.visibility === 'private'
                    ? 'Private room'
                    : 'Public room'}
                </p>
                <h2 id="join-room-title">{selectedRoom.roomName}</h2>
              </div>
              <button
                aria-label="Close"
                onClick={closeDialogs}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <form className="dialog-form" onSubmit={handleJoin}>
              <div className="opponent-preview">
                <ProfileAvatar
                  name={selectedRoom.hostProfile.displayName}
                  profile={selectedRoom.hostProfile}
                />
                <span>
                  <small>Opponent</small>
                  <strong>{selectedRoom.hostProfile.displayName}</strong>
                  <em>{profileRecordLabel(selectedRoom.hostProfile)}</em>
                </span>
              </div>
              <label className="form-field">
                <span>Display name</span>
                <input
                  autoComplete="nickname"
                  autoFocus
                  maxLength={24}
                  onChange={(event) => {
                    setName(event.target.value)
                    onClearError()
                  }}
                  placeholder="Your name"
                  required
                  value={name}
                />
              </label>
              <AvatarPicker
                name={name}
                onChange={(nextAvatar) => {
                  setAvatarKey(nextAvatar)
                  onClearError()
                }}
                value={avatarKey}
              />

              {selectedRoom.visibility === 'private' ? (
                <label className="form-field">
                  <span>Password</span>
                  <input
                    autoComplete="current-password"
                    maxLength={64}
                    onChange={(event) => {
                      setJoinPassword(event.target.value)
                      onClearError()
                    }}
                    placeholder="Room password"
                    required
                    type="password"
                    value={joinPassword}
                  />
                </label>
              ) : null}

              {renderError()}

              <button
                className="action-button action-button--primary"
                disabled={isBusy}
                type="submit"
              >
                {isBusy ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="loading-icon"
                  />
                ) : selectedRoom.visibility === 'private' ? (
                  <LockKeyhole aria-hidden="true" />
                ) : (
                  <Users aria-hidden="true" />
                )}
                Join room
              </button>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  )
}
