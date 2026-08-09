# Runtime flows

## Create or join an online room

```mermaid
sequenceDiagram
  autonumber
  actor Player
  participant UI as React UI
  participant Remote as useRemoteGameSession
  participant HTTP as Profile HTTP API
  participant Profile as ProfileService
  participant Socket as Socket.IO handlers
  participant Room as RoomManager
  participant Store as Room/Profile stores

  Player->>UI: Submit name, avatar, and room details
  UI->>Remote: createRoom(...) or joinRoom(...)
  Remote->>HTTP: POST /api/profiles/session
  HTTP->>Profile: ensureSession(credentials?, details)
  Profile->>Store: authenticate/create/update profile
  Store-->>Profile: Stored public profile
  Profile-->>Remote: Profile + raw browser credential
  Remote->>Socket: room:create or room:join (commandId + credential)
  Socket->>Socket: Rate-limit and Zod-validate
  Socket->>Profile: Authenticate credential
  opt joining two persistent profiles
    Socket->>Profile: Load rivalry record
  end
  Socket->>Room: Create/join with authenticated public profile
  Room->>Store: Persist room mutation + command receipt
  Room-->>Socket: Identity and initial snapshot
  Socket->>Socket: Join Socket.IO room and attach socket metadata
  Socket-->>Remote: Ack response
  Remote->>Remote: Store seat identity in sessionStorage
  Remote-->>UI: Render authoritative snapshot
```

The profile credential is browser-scoped and survives tabs/visits in local
storage. The room identity contains a seat reconnect token and is tab-scoped in
session storage. Create/join command IDs are retained in session storage long
enough to safely retry an uncertain request.

## Authoritative move and next round

```mermaid
sequenceDiagram
  autonumber
  actor Player
  participant Client as Remote session
  participant Gateway as Socket.IO handler
  participant Manager as RoomManager
  participant Rules as matchReducer / engine
  participant RoomStore as RoomStateStore
  participant History as HistoryRecorder
  participant Profiles as ProfileService
  participant Peers as Sockets in room

  Player->>Client: Select empty square
  Client->>Gateway: game:play(room, token, commandId, index)
  Gateway->>Gateway: Rate-limit and validate schema
  Gateway->>Manager: playMove(payload, socketId)
  Manager->>Manager: Lock command, check receipt, and authorize seat
  Manager->>Rules: matchReducer(state, play)
  Rules-->>Manager: New state or unchanged invalid move
  alt accepted move
    Manager->>RoomStore: Commit snapshot + idempotency receipt
    Manager-->>History: Record move / round lifecycle
    opt round completed with persistent profiles
      Manager-->>Profiles: Record aggregate and rivalry outcome
    end
    Manager-->>Peers: room:snapshot with incremented revision
    Manager-->>Gateway: Successful ack + snapshot
  else rejected or duplicate
    Manager-->>Gateway: Error/current snapshot or cached response
  end
  Gateway-->>Client: Ack
```

After a completed round, each player sends `game:ready-next`. `RoomManager`
tracks readiness by mark and advances the reducer only when both occupied seats
are ready. The new round alternates the starting player. A command receipt
prevents a retry from applying the same action twice; persistence queues retain
per-room write ordering.

## Disconnect and resume

```mermaid
stateDiagram-v2
  [*] --> Connected: create / join / resume
  Connected --> ReservedOffline: socket disconnect
  ReservedOffline --> Connected: room:resume with valid token\nbefore grace deadline
  ReservedOffline --> SeatExpired: reconnect grace elapses
  Connected --> Left: acknowledged room:leave
  ReservedOffline --> RoomExpired: room TTL cleanup
  Connected --> RoomExpired: room TTL cleanup
  SeatExpired --> [*]
  Left --> [*]
  RoomExpired --> [*]

  note right of ReservedOffline
    Snapshot marks player disconnected.
    Seat and token remain reserved.
    PostgreSQL snapshots can survive a process restart.
  end note
```

On transport disconnect, the server removes the socket index entry, marks the
seat offline, persists the deadline, and broadcasts state. The browser enters
`reconnecting`; after Socket.IO reconnects it sends `room:resume` with the
saved seat token. During process recovery all restored players begin offline,
and expiration timers are recreated from persisted deadlines.

## Lobby directory synchronization

```mermaid
sequenceDiagram
  participant Client as Remote session
  participant Server as Game server
  participant Manager as RoomManager

  Client->>Server: rooms:list
  Server->>Manager: getDirectory()
  Manager-->>Client: Full list + revision N
  Manager-->>Client: rooms:delta revision N+1
  Client->>Client: Apply upserts/removals and sort
  Manager-->>Client: rooms:delta revision N+3
  Note over Client: Revision N+2 was missed
  Client->>Server: rooms:list
  Server-->>Client: Full list + latest revision
```

Directory revisions are separate from each room's snapshot revision. The
client ignores old deltas, applies the next contiguous delta, and requests a
full directory whenever it sees a gap. Concurrent refresh requests are
coalesced by the remote-session hook.

## Service startup and shutdown

```mermaid
flowchart TD
  Start[server/index.ts] --> Construct[Construct Express, Socket.IO, services, and stores]
  Construct --> HInit[Initialize history]
  HInit --> PInit[Initialize profiles]
  PInit --> RInit[Initialize room store and restore active rooms]
  RInit --> Timers[Recreate disconnect/expiry timers and persist normalized snapshots]
  Timers --> Listen[Bind HTTP server]
  Listen --> Started[Record service_started]
  Started --> Serve[Serve HTTP, Socket.IO, and production static assets]
  Serve --> Signal[SIGINT or SIGTERM]
  Signal --> StopHTTP[Stop accepting HTTP/socket traffic]
  StopHTTP --> Close[Close room manager, profiles, and history]
  Close --> Exit[Exit process]

  PInit -. initialization error .-> Cleanup[Close initialized services]
  RInit -. initialization error .-> Cleanup
  Cleanup --> Fail[Fail startup]
```
