# Scale and Product Plan

## Recommendation

Ship the current release on one game-server instance with managed PostgreSQL.
PostgreSQL now retains active-room snapshots, short-lived idempotency receipts,
profiles, rivalries, and lifecycle events across deploys. Keep live room
authority in one Node process until Redis owns atomic room mutations and
Socket.IO fan-out.

Standard 3x3 tic tac toe cannot support a durable ranked ladder by itself.
Optimal play forces a draw because researchers have solved the game
([Tic-tac-toe](https://en.wikipedia.org/wiki/Tic-tac-toe)). Use 3x3 for fast
friend matches, then make Ultimate Tic Tac Toe or Gomoku the first ranked
format.

## Current Release

The release includes:

- Public and password-protected rooms, invite links, reconnects, and
  server-authoritative moves.
- Anonymous browser profiles with color avatars and public casual records.
- Host previews in the room directory and all-time rivalry context during a
  match.
- PostgreSQL event history through a provider-neutral `DATABASE_URL`.
- PostgreSQL active-room snapshots, including reconnect deadlines and private
  password verifiers.
- Ten-minute idempotency receipts for successful create, join, resume, move,
  ready, and leave commands.
- Revisioned room-directory deltas with full-snapshot recovery after a gap.
- PostgreSQL profile and rivalry records with SHA-256 token hashes.
- Replay-grade move events with internal room, player, and match UUIDs.
- Service start and stop records with provider instance and release labels
  when the host supplies them.
- Protected summary and event APIs plus the `/admin` operator view.
- A 365-day default retention window, configurable through
  `HISTORY_RETENTION_DAYS`.

The browser keeps its raw profile token in local storage. The server stores
only the token hash and excludes profile tokens from lifecycle history. The
event recorder also removes password, room-code, reconnect-token, socket,
hash, salt, cookie, and authorization fields from nested payloads. It buffers
a failed write so a short database outage does not stop a live match. The
recorder caps the buffer at 10,000 events to protect the game process.

These profiles provide casual continuity on one browser. They do not support
login, recovery, cross-device use, or ranked trust. A player who clears site
data receives a new identity.

One process still owns each live room in memory. PostgreSQL snapshots let a
replacement process restore the board, scores, seats, reconnect tokens, and
private-room verifier. Recovery marks each restored seat disconnected; the
browser can resume it during the reconnect grace period. History records a
`room_recovered` event without exposing room credentials.

Do not run a second game-server instance yet. Both processes could load the
same snapshot, accept conflicting commands, and publish unrelated directory
revision streams. PostgreSQL stores recovery state but does not provide the
atomic compare-and-update authority or cross-node broadcasts required for
horizontal game traffic. The Render Blueprint fixes `numInstances` at `1`.

## Deployment Contract

Any container host can run the same image when it supplies:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Managed PostgreSQL connection |
| `DATABASE_SSL=require` | TLS for providers that require it |
| `ADMIN_API_KEY` | Shared operator credential for `/admin` |
| `HISTORY_RETENTION_DAYS` | Startup cleanup threshold |
| `TRUST_PROXY` | Trusted proxy hops used to resolve the client IP |
| `PROFILE_CREATION_RATE_LIMIT_MAX` | Profiles one client can create per window |
| `PROFILE_CREATION_RATE_LIMIT_WINDOW_MS` | Profile creation window in milliseconds |
| `SERVICE_INSTANCE_ID` | Optional host instance label |
| `RELEASE_SHA` | Optional release label |

Render can create these resources from `render.yaml`. Railway, Fly.io, ECS, or
another container host can use the Dockerfile and the same variables. Connect
through each provider's private database network. Store `ADMIN_API_KEY` in the
provider's secret manager and rotate it after staff changes.

The server runs idempotent schema creation before it accepts traffic. A
database connection failure stops startup when `DATABASE_URL` exists. Without
that variable, `/health` reports memory backends for room state, history, and
profiles; that mode loses rooms, receipts, events, casual records, and
rivalries at restart.

Restrict database access. Active-room snapshots contain reconnect tokens and
scrypt password salts and hashes because a replacement process needs them to
restore private rooms. Lifecycle history continues to exclude those fields.

## Scale Path

### Phase 1: Measure One Instance

Run load tests against room creation, two-player move bursts, reconnects, and
directory broadcasts. Track:

- p95 move acknowledgement under 250 ms.
- p95 room join under 500 ms.
- reconnect success above 99% during a 60-second seat reservation.
- recovered-room resume success after a rolling deploy.
- duplicate-command side effects at zero.
- event-buffer depth at zero during steady traffic.
- room-state and event write failures plus database query latency.

Add OpenTelemetry traces and metrics before traffic makes platform logs hard
to correlate. OpenTelemetry separates traces, metrics, and logs into distinct
signals ([OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)).
Export them to the monitoring service supplied by the chosen host.

Exit Phase 1 after one instance approaches 60% sustained CPU, room-directory
broadcasts affect move latency, or availability requirements demand more than
one instance.

### Phase 2: Move Live Authority to Redis

An adapter alone does not share `RoomManager` state. Move these records to
Redis first:

- Room metadata, player seats, ready state, board, scores, and revision.
- Reconnect leases and room expiration.
- Room-directory indexes by visibility, occupancy, and activity.
- Idempotency keys and cached responses for every mutation command.

Use an atomic Lua script or a Redis transaction for each command. The script
must compare the expected room revision, validate the move, update state, and
increment the revision as one operation. PostgreSQL remains the append-only
history store.

Add the Socket.IO Redis Streams adapter for cross-instance broadcasts. Its
documented features include temporary Redis-disconnect recovery and Socket.IO
connection-state recovery
([Redis Streams adapter](https://socket.io/docs/v4/redis-streams-adapter/)).
Socket.IO requires sticky sessions while HTTP long-polling remains enabled.
WebSocket-only clients remove that requirement, but reconnects can still reach
another instance
([Using multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)).
Render states that a reconnect may land on any instance
([WebSockets on Render](https://render.com/docs/websocket)).

Exit Phase 2 after tests prove that two instances can accept alternating
commands for one room, survive one instance terminating, reject duplicate
moves, preserve ordered directory revisions, and recover a disconnected seat.

### Phase 3: Separate Workloads

Split the service when traffic warrants the operating cost:

- Game gateway: Socket.IO connections and command validation.
- Match worker: tournaments, matchmaking, ratings, and scheduled challenges.
- History API: operator queries and replay reads.

Partition PostgreSQL history by month after indexes no longer keep range
queries within the latency target. Send product analytics to a warehouse
instead of adding dashboard scans to the game database. Add per-account and
per-IP limits at the edge.

## Competitive Product Direction

[PaperGames](https://papergames.io/en/tic-tac-toe) shows the expected social
baseline: friend links, live play, profiles, tournaments, replays, and game
choices with more depth. Build in this order:

1. **Accounts, match records, and replays.** Convert the event stream into
   player-facing match records. Let a player claim a browser profile after
   authentication, then add account recovery, deletion, and display-name
   moderation. Keep pre-account results outside ranked ratings.
2. **A deeper ranked format.** Launch Ultimate Tic Tac Toe or Gomoku with
   unranked queues first. Measure rules completion, draw rate, and match
   duration before enabling ratings.
3. **Glicko-2 matchmaking and seasons.** Glicko-2 models rating uncertainty
   ([Glicko-2 specification](https://www.glicko.net/glicko/glicko2.pdf)),
   which helps new and returning players reach suitable opponents. Keep private
   friend matches unrated.
4. **Bots and daily challenges.** Use a proven engine for each game variant.
   Daily positions give solo players a repeat reason to return.
5. **Spectating and tournaments.** Build read-only room subscriptions, delayed
   spectator updates, brackets, and seasonal leaderboards.

Delay chat until accounts, reporting, blocking, and moderation tools exist.
Do not use raw 3x3 win rate as the main skill signal; optimal players will
produce a high draw rate.

### Leaderboard Gate

Do not publish a ranked leaderboard from anonymous browser profiles. Players
can reset those identities, share their token, or play both sides from
separate browsers. Launch a public leaderboard after accounts, abuse controls,
rating eligibility rules, and a deeper ranked format exist. The current
win/loss/draw and rivalry displays give players useful opponent context
without claiming a verified rank.

## Product Measures

Use the event stream to calculate:

- Profile creation, update, and return rates by release.
- Room creation to second-player join conversion.
- Join rejection rate by reason, with private-password failures separated.
- Match completion and rematch rates.
- Median rounds and moves per match.
- Reconnect success after a disconnect.
- 1-day and 7-day return rates after accounts launch.
- Queue time, rating spread, and draw rate for each ranked format.

Set an event schema version before adding account IDs. Backfill derived match
tables from immutable events, and keep the source events until the retention
policy removes them.

## Security and Operations

The shared `ADMIN_API_KEY` fits a small operator group. Replace it with
identity-provider login and role checks before granting broad staff access.
Record operator reads after identity exists.

The in-process profile creation limiter protects the database from simple
creation loops. Configure `TRUST_PROXY` for the deployment topology and add an
edge or shared limiter before running multiple game servers. Use a strict
content security policy because local storage exposes the raw profile token to
JavaScript running on the game origin.

Use private network access for PostgreSQL, automated backups, restore tests,
and a retention value that matches the privacy policy. Render Blueprints can
wire generated secrets and database connection properties into a service
([Blueprint specification](https://render.com/docs/blueprint-spec)); Render
also documents private and external PostgreSQL URLs
([PostgreSQL connections](https://render.com/docs/postgresql-creating-connecting)).

Alert on:

- `/health` failures or degraded room-state, history, or profile status.
- PostgreSQL storage, connection, and query-latency thresholds.
- active-room recovery spikes after a release.
- reconnect failure spikes and room-close spikes.
- join rejection changes after a release.
- event volume dropping to zero while matches remain active.
