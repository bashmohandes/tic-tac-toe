# Data and deployment architecture

## Data ownership

```mermaid
erDiagram
  ACTIVE_ROOM ||--o{ COMMAND_RECEIPT : "mutation retry"
  ACTIVE_ROOM ||--|{ ROOM_PLAYER : contains
  PLAYER_PROFILE ||--o{ ROOM_PLAYER : "public projection"
  PLAYER_PROFILE ||--o{ RIVALRY : first_player
  PLAYER_PROFILE ||--o{ RIVALRY : second_player
  ACTIVE_ROOM ||--o{ HISTORY_EVENT : describes
  MATCH ||--o{ HISTORY_EVENT : describes

  ACTIVE_ROOM {
    uuid id
    string code
    jsonb snapshot
    timestamp expires_at
  }
  ROOM_PLAYER {
    uuid profile_or_transient_id
    string mark
    string reconnect_token
    timestamp disconnect_deadline
  }
  COMMAND_RECEIPT {
    string command_key
    jsonb response
    timestamp expires_at
  }
  PLAYER_PROFILE {
    uuid id
    string token_hash
    string display_name
    string avatar_key
    int wins
    int losses
    int draws
  }
  RIVALRY {
    uuid first_profile_id
    uuid second_profile_id
    int first_wins
    int second_wins
    int draws
  }
  MATCH {
    uuid id
  }
  HISTORY_EVENT {
    uuid event_id
    uuid room_id
    uuid match_id
    string type
    jsonb sanitized_payload
    timestamp occurred_at
  }
```

The diagram is conceptual: room players and match state are embedded in the
active-room snapshot rather than exposed through independent store interfaces.
Refer to the PostgreSQL adapters for physical table definitions.

### Store matrix

| Domain | Owner | Memory behavior | PostgreSQL behavior |
| --- | --- | --- | --- |
| Live rooms | `RoomManager` | Always authoritative in one process. | Snapshots restore a replacement process; PostgreSQL is not live authority. |
| Command receipts | `RoomManager` | Map entries expire after ten minutes. | Durable responses make retries idempotent across a restart until expiry. |
| Profiles and rivalries | `ProfileService` | Lost on restart. | Token hashes, public profile totals, and pair totals survive restart. |
| History | `HistoryRecorder` | Buffered/queryable only for process lifetime. | Batched event history and summaries survive according to retention settings. |

Storage selection is all-or-nothing through `DATABASE_URL`: each of the three
factory functions independently chooses its PostgreSQL adapter when the value
is present. Initialization creates the required tables. The adapters use the
same database but keep separate interfaces and lifecycle ownership.

## Data classification and trust boundaries

```mermaid
flowchart LR
  Internet((Untrusted browser input)) -->|Zod schemas, size limits, rate limits| Gateway[Express / Socket.IO gateway]
  Gateway -->|Authenticated profile| Profile[ProfileService]
  Gateway -->|Authorized seat token + socket| Room[RoomManager]
  Gateway -->|Timing-safe operator credential| Admin[History queries]
  Room -->|Public snapshots only| Internet
  Profile -->|Public profile + one-time/raw browser token| Internet
  Room -->|Password verifier, reconnect token| Private[(Private room persistence)]
  Profile -->|SHA-256 token hash| Private
  Room -->|Lifecycle draft| Sanitize[History payload sanitizer]
  Profile -->|Lifecycle draft| Sanitize
  Sanitize --> History[(History storage)]
```

Security-relevant properties:

- Socket handshakes accept configured origins, same-host origins, and local
  development origins. Non-browser clients without an `Origin` header are
  accepted.
- Express limits JSON bodies to 10 KiB; Socket.IO limits messages to 10,000
  bytes. Socket commands are rate-limited per connection. New profile issuance
  is separately limited by client address, with `TRUST_PROXY` controlling
  address interpretation behind a proxy.
- Private-room passwords use `scrypt` with a random salt. Profile bearer tokens
  are stored as SHA-256 hashes. Comparisons use timing-safe equality where
  applicable.
- The operator key is accepted through `x-admin-api-key` or a Bearer header and
  held by the admin UI in session storage. Admin and profile responses disable
  caching.
- History sanitization excludes known sensitive key names. Event producers
  should still use internal room/match UUIDs and avoid placing credentials,
  room codes, socket IDs, or personal secrets in payloads.

## Production deployment

```mermaid
flowchart TB
  Browser[Browser]
  Proxy[Hosting provider TLS / reverse proxy]

  subgraph Instance[Single Node.js instance / container]
    HTTP[Express + Socket.IO\none TCP port]
    Static[Vite dist assets]
    Authority[In-memory RoomManager authority]
    HTTP --> Static
    HTTP --> Authority
  end

  DB[(Private PostgreSQL)]

  Browser <-->|HTTPS + WebSocket/polling| Proxy
  Proxy <-->|HTTP, trusted proxy hop| HTTP
  Authority -->|room snapshots + receipts| DB
  HTTP -->|profiles, rivalries, history| DB
  Proxy -->|GET /health| HTTP
```

The multi-stage Docker build produces Vite assets and an ESM Node server, then
runs as the unprivileged `node` user. In production, Express serves the SPA and
falls back to `index.html` for HTML routes, including `/admin`. Render is
configured for one application instance and a private PostgreSQL database.
Health output reports room count and the backend/status of each persistence
subsystem.

## Availability and scaling constraints

The current architecture is deliberately **single-writer, single-instance**:

- Socket.IO rooms and broadcasts use the process-local adapter.
- The socket-to-seat index, disconnect timers, directory revision, command
  locks, persistence queues, and live room map are process-local.
- PostgreSQL snapshots are recovery checkpoints, not leases or compare-and-set
  ownership records.
- Two application instances could accept conflicting moves for the same room
  and could not reliably broadcast changes to each other's clients.

Before horizontal scaling, introduce one atomic room-authority strategy (for
example Redis-backed commands/locks or database transactions with fencing), a
cross-instance Socket.IO adapter, globally ordered directory delivery, and a
single owner for timers/expiry. Load-balancer stickiness alone is insufficient
because reconnects, lobby broadcasts, and process failure cross instance
boundaries. The broader product and scale sequence is documented in
`docs/scale-and-product-plan.md`.

## Failure behavior

| Failure | Current behavior |
| --- | --- |
| Browser loses transport | Seat is reserved for the disconnect grace period; Socket.IO retries and the client resumes with its saved token. |
| Node process restarts without PostgreSQL | Rooms, receipts, profiles, rivalries, and history are lost. |
| Node process restarts with PostgreSQL | Valid active rooms and receipts are restored; players begin disconnected and may resume before their deadlines. |
| PostgreSQL unavailable at startup | Store initialization fails and the server does not bind its listening port. |
| History write fails after startup | Recorder status can degrade; game authority remains separate from history recording. |
| Profile query/update fails | Profile-dependent entry or score update reports/logs failure; room authority remains in `RoomManager`. |
| Client misses a lobby delta | Revision gap triggers a full directory refresh. |
| Client retries a command | Cached receipt returns the prior response during the receipt TTL. |

## Observability and operations

- `GET /health` is the unauthenticated liveness/readiness surface used by the
  deployment manifest.
- `/admin` queries protected summary and paginated event endpoints for the
  configured reporting window.
- Lifecycle history includes service, room, player, match, round, move,
  disconnect, and recovery events with deployment identity when available.
- Graceful `SIGINT`/`SIGTERM` handling closes the HTTP server and domain
  services so queued persistence/history work can finish.
