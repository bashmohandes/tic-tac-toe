# Tic Tac Toe

A React and TypeScript tic tac toe game with local matches, browsable online
rooms, casual player profiles, and rivalry records. PostgreSQL can retain
active rooms, command receipts, profiles, rivalries, and service history
across deployments.

## Development

```bash
npm ci
npm run dev
```

Vite serves the browser app at `http://127.0.0.1:5173`. The Socket.IO server
runs on port `3001`, and Vite proxies game traffic to it.

## Checks

```bash
npm test
npm run lint
npm run build
npm run check:visual
npm run check:online
ADMIN_API_KEY=your-local-key npm run check:admin
```

Run `npm run dev` before either browser check.

## Online Rooms

The Node server owns each room and validates every move with the shared game
engine. The lobby lists public and private rooms with host names, profile
colors, casual records, occupancy, and connection status. Players can inspect
the host before joining. Private rooms prompt for a password in the same flow.

Hosts name each room and can share its six-character invite URL. The server
hashes private-room passwords with scrypt and omits passwords and reconnect
tokens from directory responses. Each browser tab stores its reconnect token
in session storage.

With `DATABASE_URL`, the server writes a private active-room snapshot after
each accepted mutation. A replacement process restores the board, scores,
seats, password verifier, and reconnect tokens. Restored players start
disconnected and can reclaim their seats during the reconnect grace period.
The server also keeps successful command responses for ten minutes, so a
retried create, join, move, ready, or leave command does not apply twice.

Lobby updates use ordered revision deltas. A browser that misses a revision
requests a full directory snapshot before applying more updates.

Run one server instance. The live room map and Socket.IO broadcasts still
belong to that process; PostgreSQL provides restart recovery, not concurrent
room authority. Without `DATABASE_URL`, active rooms and command receipts use
memory and disappear at restart.

## Player Profiles

The server issues an anonymous profile when a browser first creates or joins
an online room. The browser keeps the profile ID and raw token in local
storage. PostgreSQL stores the token's SHA-256 hash, public profile details,
win/loss/draw totals, and each two-player rivalry record.

The match view shows both player names, colors, casual records, connection
state, and their all-time head-to-head results. A profile follows the browser
across tabs and visits. Clearing site data or moving to another browser or
device creates a new profile because this release has no login, recovery, or
cross-device sync.

Treat these records as social context, not ranked identity. A player can reset
a browser profile, and standard 3x3 tic tac toe has little room for a useful
skill ladder. Authenticated accounts and a deeper game format should precede a
public ranked leaderboard.

## Match History

Set `DATABASE_URL` and `ADMIN_API_KEY` before starting the server. The server
creates active-room, command-receipt, event, profile, and rivalry tables at
startup. Without `DATABASE_URL`, it uses in-memory stores for local work and
tests.

Open `/admin` and enter the operator key to view room, match, move, outcome,
join, disconnect, profile, and deployment events. The browser holds the key in
session storage. History records use internal UUIDs and exclude room codes,
passwords, profile tokens, reconnect tokens, socket IDs, and token or password
hashes.

Useful settings:

```bash
DATABASE_URL=postgresql://user:password@host:5432/database
DATABASE_SSL=require
HISTORY_RETENTION_DAYS=365
ADMIN_API_KEY=replace-with-a-long-random-value
TRUST_PROXY=1
PROFILE_CREATION_RATE_LIMIT_MAX=10
PROFILE_CREATION_RATE_LIMIT_WINDOW_MS=600000
```

Use `DATABASE_SSL=require` when your PostgreSQL provider requires TLS.
Set `TRUST_PROXY` to the number of trusted proxy hops so the profile creation
limit sees the client address. `/health` reports the room-state, history, and
profile backends and their status.

## Production

```bash
npm run build
NODE_ENV=production PORT=3000 npm start
```

The production process serves the Vite build and Socket.IO from one origin.
Set `ALLOWED_ORIGINS` to a comma-separated list when another origin needs
socket access.

The included `Dockerfile` works with container hosts. `render.yaml` provides a
single-instance Render service, a private PostgreSQL database shared by room
state, profiles, and history, a generated operator key, proxy-aware profile
limits, and the `/health` endpoint.

Keep the service at one instance until Redis provides atomic room authority
and cross-instance Socket.IO delivery. Read
[the scale and product plan](docs/scale-and-product-plan.md) before raising
the instance count.

## Structure

- `src/game/engine.ts` contains the pure game rules.
- `src/game/match.ts` manages rounds and scores.
- `src/game/protocol.ts` defines runtime schemas and socket event types.
- `src/game/remote-session.ts` adapts room snapshots to the UI.
- `server/room-manager.ts` owns room state and reconnect handling.
- `server/rooms/` persists active-room snapshots and command receipts.
- `server/game-server.ts` exposes the HTTP and Socket.IO service.
- `server/history/` stores and queries lifecycle events.
- `server/profiles/` stores browser profiles and rivalry totals.
- `src/components/AdminDashboard.tsx` renders the operator history view.
