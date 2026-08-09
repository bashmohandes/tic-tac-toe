import { useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Equal,
  Grid3X3,
  LoaderCircle,
  LogOut,
  RotateCcw,
  Trophy,
  UserRoundPlus,
  WifiOff,
  X,
} from 'lucide-react'
import { GameBoard } from './components/GameBoard'
import { AdminDashboard } from './components/AdminDashboard'
import {
  ModeSwitcher,
  type GameMode,
} from './components/ModeSwitcher'
import { OnlineLobby } from './components/OnlineLobby'
import { PlayerMark } from './components/PlayerMark'
import { ProfileAvatar } from './components/ProfileAvatar'
import {
  otherPlayer,
  type Player,
  type RoundState,
} from './game/engine'
import {
  getRoomCodeFromUrl,
  hasStoredOnlineSession,
  useRemoteGameSession,
  type OnlineConnectionState,
} from './game/remote-session'
import { profileRecordLabel } from './game/profile-display'
import {
  useLocalGameSession,
  type GameSession,
} from './game/session'
import type {
  RoomPlayerSnapshot,
  RoomSnapshot,
  SessionIdentity,
  PublicPlayerProfile,
} from './game/protocol'
import './App.css'

const PLAYER_NAMES: Record<Player, string> = {
  X: 'Crosses',
  O: 'Circles',
}
const LOCAL_PROFILES: Record<Player, PublicPlayerProfile> = {
  X: {
    id: '00000000-0000-4000-8000-000000000001',
    displayName: PLAYER_NAMES.X,
    avatarKey: 'coral',
    record: { wins: 0, losses: 0, draws: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  O: {
    id: '00000000-0000-4000-8000-000000000002',
    displayName: PLAYER_NAMES.O,
    avatarKey: 'teal',
    record: { wins: 0, losses: 0, draws: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

interface RoundMessage {
  readonly title: string
  readonly detail: string
  readonly symbol: 'player' | 'draw' | 'waiting' | 'offline' | 'loading'
}

interface OnlineGameContext {
  readonly connectionState: OnlineConnectionState
  readonly error: string | null
  readonly identity: SessionIdentity
  readonly isSubmitting: boolean
  readonly onClearError: () => void
  readonly snapshot: RoomSnapshot
}

function getLocalRoundMessage(round: RoundState): RoundMessage {
  if (round.status === 'won' && round.winner) {
    return {
      title: `${PLAYER_NAMES[round.winner]} win`,
      detail: 'Three in a row.',
      symbol: 'player',
    }
  }

  if (round.status === 'draw') {
    return {
      title: 'Round draw',
      detail: 'All nine squares are filled.',
      symbol: 'draw',
    }
  }

  return {
    title: `${PLAYER_NAMES[round.currentPlayer]} to move`,
    detail: `${PLAYER_NAMES[round.startingPlayer]} opened this round.`,
    symbol: 'player',
  }
}

function getOnlineRoundMessage(
  round: RoundState,
  online: OnlineGameContext,
): RoundMessage {
  if (
    online.connectionState === 'connecting' ||
    online.connectionState === 'reconnecting'
  ) {
    return {
      title: 'Reconnecting',
      detail: `Restoring your seat in ${online.snapshot.roomCode}.`,
      symbol: 'loading',
    }
  }

  const opponentMark = otherPlayer(online.identity.player)
  const opponent = online.snapshot.players[opponentMark]

  if (!opponent) {
    return {
      title: 'Waiting for opponent',
      detail: `${online.snapshot.roomName} is open.`,
      symbol: 'waiting',
    }
  }

  if (!opponent.connected) {
    return {
      title: `${opponent.name} disconnected`,
      detail: 'Their seat remains reserved.',
      symbol: 'offline',
    }
  }

  if (round.status !== 'playing') {
    if (round.status === 'draw') {
      return {
        title: 'Round draw',
        detail: 'The rivalry record now includes this draw.',
        symbol: 'draw',
      }
    }

    const winner = round.winner
      ? online.snapshot.players[round.winner]
      : null
    return {
      title: `${winner?.name ?? 'Player'} wins`,
      detail: `Match score ${online.snapshot.match.scores.X}-${online.snapshot.match.scores.O}.`,
      symbol: 'player',
    }
  }

  if (round.currentPlayer === online.identity.player) {
    return {
      title: 'Your move',
      detail: `You are ${PLAYER_NAMES[online.identity.player]}.`,
      symbol: 'player',
    }
  }

  return {
    title: `${opponent.name} to move`,
    detail: `You are ${PLAYER_NAMES[online.identity.player]}.`,
    symbol: 'player',
  }
}

interface PlayerScoreProps {
  readonly player: Player
  readonly score: number
  readonly isActive: boolean
  readonly isOpen?: boolean
  readonly isYou?: boolean
  readonly name: string
  readonly connected?: boolean
  readonly profile?: PublicPlayerProfile
}

function PlayerScore({
  player,
  score,
  isActive,
  isOpen = false,
  isYou = false,
  name,
  connected = true,
  profile,
}: PlayerScoreProps) {
  const pointLabel = score === 1 ? 'point' : 'points'
  const scoreLabel = isOpen ? PLAYER_NAMES[player] : name
  const classes = [
    'score-row',
    isActive ? 'score-row--active' : '',
    !connected && !isOpen ? 'score-row--offline' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <span className={`score-mark ${profile ? 'score-mark--profile' : ''}`}>
        {profile ? (
          <>
            <ProfileAvatar name={name} profile={profile} />
            <span className="score-mark-badge">
              <PlayerMark player={player} />
            </span>
          </>
        ) : (
          <PlayerMark player={player} />
        )}
      </span>
      <span className="score-player">
        <strong>{profile ? name : player}</strong>
        <span>
          {isOpen
            ? 'Open seat'
            : profile
              ? `${player} / ${profileRecordLabel(profile)}${
                  isYou ? ' / You' : ''
                }`
              : `${name}${isYou ? ' (You)' : ''}`}
        </span>
      </span>
      <strong
        aria-label={`${scoreLabel}: ${score} ${pointLabel}`}
        className="score-value"
      >
        {score}
      </strong>
    </div>
  )
}

function RoundSymbol({
  message,
  round,
}: {
  readonly message: RoundMessage
  readonly round: RoundState
}) {
  const statusPlayer = round.winner ?? round.currentPlayer
  const classes = [
    'status-symbol',
    message.symbol === 'draw' ? 'status-symbol--draw' : '',
    message.symbol === 'waiting' ? 'status-symbol--waiting' : '',
    message.symbol === 'offline' ? 'status-symbol--offline' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes}>
      {message.symbol === 'draw' ? (
        <Equal aria-hidden="true" strokeWidth={1.8} />
      ) : message.symbol === 'waiting' ? (
        <UserRoundPlus aria-hidden="true" strokeWidth={1.8} />
      ) : message.symbol === 'offline' ? (
        <WifiOff aria-hidden="true" strokeWidth={1.8} />
      ) : message.symbol === 'loading' ? (
        <LoaderCircle
          aria-hidden="true"
          className="loading-icon"
          strokeWidth={1.8}
        />
      ) : (
        <PlayerMark player={statusPlayer} />
      )}
    </span>
  )
}

function getConnectionLabel(online: OnlineGameContext): string {
  if (
    online.connectionState === 'connecting' ||
    online.connectionState === 'reconnecting'
  ) {
    return 'Reconnecting'
  }

  const opponent =
    online.snapshot.players[otherPlayer(online.identity.player)]

  if (!opponent) {
    return 'Waiting for player'
  }

  if (!opponent.connected) {
    return 'Opponent offline'
  }

  return 'Both players connected'
}

function buildInviteUrl(roomCode: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('room', roomCode)
  return url.toString()
}

interface GameViewProps {
  readonly online?: OnlineGameContext
  readonly session: GameSession
}

function GameView({ online, session }: GameViewProps) {
  const { state, nextRound, play, restartRound } = session
  const { round, roundNumber, scores } = state
  const [inviteCopied, setInviteCopied] = useState(false)
  const message = online
    ? getOnlineRoundMessage(round, online)
    : getLocalRoundMessage(round)
  const isPlaying = round.status === 'playing'
  const players: Record<Player, RoomPlayerSnapshot | null> = online
    ? online.snapshot.players
    : {
        X: {
          mark: 'X',
          name: PLAYER_NAMES.X,
          connected: true,
          profile: LOCAL_PROFILES.X,
        },
        O: {
          mark: 'O',
          name: PLAYER_NAMES.O,
          connected: true,
          profile: LOCAL_PROFILES.O,
        },
      }
  const readyForNextRound = online?.snapshot.readyForNextRound ?? []
  const localPlayerReady = online
    ? readyForNextRound.includes(online.identity.player)
    : false

  async function copyInvite(): Promise<void> {
    if (!online || !navigator.clipboard) {
      return
    }

    try {
      await navigator.clipboard.writeText(
        buildInviteUrl(online.snapshot.roomCode),
      )
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1_600)
    } catch {
      setInviteCopied(false)
    }
  }

  return (
    <main className="game-layout" id="game-surface">
      <section className="play-area" aria-labelledby="round-status">
        <div className="round-status" aria-live="polite" aria-atomic="true">
          <div className="status-copy">
            <p className="eyebrow">
              Round {String(roundNumber).padStart(2, '0')}
            </p>
            <h1 id="round-status">{message.title}</h1>
            <p>{message.detail}</p>
          </div>
          <RoundSymbol message={message} round={round} />
        </div>

        <GameBoard
          canInteract={session.canPlay}
          onPlay={play}
          round={round}
        />
      </section>

      <aside className="match-panel" aria-labelledby="match-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">
              {online
                ? `${online.snapshot.visibility} room`
                : 'Scoreboard'}
            </p>
            <h2 id="match-heading">
              {online ? online.snapshot.roomName : 'Match'}
            </h2>
            {online ? (
              <span
                className="panel-room-code"
                data-room-code={online.snapshot.roomCode}
              >
                {online.snapshot.roomCode}
              </span>
            ) : null}
          </div>
          {online ? (
            <button
              aria-label="Copy room invite"
              className="panel-icon-button"
              data-tooltip={inviteCopied ? 'Copied' : 'Copy invite'}
              onClick={() => void copyInvite()}
              type="button"
            >
              {inviteCopied ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </button>
          ) : (
            <Trophy aria-hidden="true" strokeWidth={1.8} />
          )}
        </div>

        <div className="scoreboard">
          {(['X', 'O'] as const).map((player) => {
            const playerDetails = players[player]
            const isOpen = playerDetails === null

            return (
              <PlayerScore
                connected={playerDetails?.connected}
                isActive={
                  isPlaying &&
                  round.currentPlayer === player
                }
                isOpen={isOpen}
                isYou={online?.identity.player === player}
                key={player}
                name={playerDetails?.name ?? PLAYER_NAMES[player]}
                player={player}
                profile={online ? playerDetails?.profile : undefined}
                score={scores[player]}
              />
            )
          })}
        </div>

        <div className="draw-score">
          <span>Draws</span>
          <strong
            aria-label={`${scores.draws} ${
              scores.draws === 1 ? 'draw' : 'draws'
            }`}
          >
            {scores.draws}
          </strong>
        </div>

        {online?.snapshot.rivalry &&
        online.snapshot.players.X &&
        online.snapshot.players.O ? (
          <div className="rivalry-record">
            <span>All-time rivalry</span>
            <div>
              <span>
                {online.snapshot.players.X.name}
                <strong>{online.snapshot.rivalry.xWins}</strong>
              </span>
              <span>
                Draws
                <strong>{online.snapshot.rivalry.draws}</strong>
              </span>
              <span>
                {online.snapshot.players.O.name}
                <strong>{online.snapshot.rivalry.oWins}</strong>
              </span>
            </div>
          </div>
        ) : null}

        <div className="round-opener">
          <span>Round opener</span>
          <strong>
            <PlayerMark player={round.startingPlayer} />
            {PLAYER_NAMES[round.startingPlayer]}
          </strong>
        </div>

        {online ? (
          <div className="connection-row">
            <span
              className={`connection-dot connection-dot--${
                getConnectionLabel(online) === 'Both players connected'
                  ? 'online'
                  : 'waiting'
              }`}
            />
            {getConnectionLabel(online)}
          </div>
        ) : null}

        {online?.error ? (
          <div className="session-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{online.error}</span>
            <button
              aria-label="Dismiss error"
              data-tooltip="Dismiss"
              onClick={online.onClearError}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {online ? (
          !isPlaying ? (
            <button
              className={`action-button ${
                localPlayerReady
                  ? 'action-button--secondary'
                  : 'action-button--primary'
              }`}
              disabled={!session.canNextRound}
              onClick={nextRound}
              type="button"
            >
              {localPlayerReady ? (
                <>
                  <LoaderCircle
                    aria-hidden="true"
                    className="loading-icon"
                  />
                  Waiting for opponent
                </>
              ) : (
                <>
                  Play again
                  <ArrowRight aria-hidden="true" />
                </>
              )}
            </button>
          ) : null
        ) : isPlaying ? (
          <button
            className="action-button action-button--secondary"
            disabled={!session.canRestartRound}
            onClick={restartRound}
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            Restart round
          </button>
        ) : (
          <button
            className="action-button action-button--primary"
            disabled={!session.canNextRound}
            onClick={nextRound}
            type="button"
          >
            Next round
            <ArrowRight aria-hidden="true" />
          </button>
        )}
      </aside>
    </main>
  )
}

function ReconnectingRoom({
  roomCode,
}: {
  readonly roomCode: string
}) {
  return (
    <main className="reconnecting-room" id="game-surface">
      <LoaderCircle aria-hidden="true" className="loading-icon" />
      <p className="eyebrow">Online match</p>
      <h1>Rejoining {roomCode}</h1>
    </main>
  )
}

function GameApp() {
  const initialRoomCode = getRoomCodeFromUrl()
  const [mode, setMode] = useState<GameMode>(() =>
    initialRoomCode || hasStoredOnlineSession() ? 'online' : 'local',
  )
  const localSession = useLocalGameSession()
  const online = useRemoteGameSession(mode === 'online')

  function changeMode(nextMode: GameMode): void {
    if (mode === nextMode) {
      return
    }

    if (mode === 'online') {
      online.leaveRoom()
    }

    setMode(nextMode)
  }

  let surface

  if (mode === 'local') {
    surface = <GameView session={localSession} />
  } else if (online.gameSession && online.identity && online.snapshot) {
    surface = (
      <GameView
        online={{
          connectionState: online.connectionState,
          error: online.error,
          identity: online.identity,
          isSubmitting: online.isSubmitting,
          onClearError: online.clearError,
          snapshot: online.snapshot,
        }}
        session={online.gameSession}
      />
    )
  } else if (online.identity) {
    surface = <ReconnectingRoom roomCode={online.identity.roomCode} />
  } else {
    surface = (
      <OnlineLobby
        connectionState={online.connectionState}
        error={online.error}
        initialRoomCode={initialRoomCode}
        isSubmitting={online.isSubmitting}
        profile={online.profile}
        rooms={online.rooms}
        onClearError={online.clearError}
        onCreateRoom={online.createRoom}
        onJoinRoom={online.joinRoom}
        onRefreshRooms={online.refreshRooms}
      />
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand" aria-label="Tic Tac Toe">
          <span className="brand-icon">
            <Grid3X3 aria-hidden="true" strokeWidth={1.8} />
          </span>
          <span>Tic Tac Toe</span>
        </div>

        <ModeSwitcher mode={mode} onChange={changeMode} />

        <div className="header-action">
          {mode === 'local' ? (
            <button
              aria-label="Reset match"
              className="icon-button"
              data-tooltip="Reset match"
              disabled={!localSession.canResetMatch}
              onClick={localSession.resetMatch}
              type="button"
            >
              <RotateCcw aria-hidden="true" />
            </button>
          ) : online.identity ? (
            <button
              aria-label="Leave room"
              className="icon-button"
              data-tooltip="Leave room"
              onClick={online.leaveRoom}
              type="button"
            >
              <LogOut aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>

      {surface}
    </div>
  )
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, '')

  return path === '/admin' ? <AdminDashboard /> : <GameApp />
}

export default App
