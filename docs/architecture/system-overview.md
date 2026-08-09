# System overview

## System context

```mermaid
C4Context
  title Tic Tac Toe system context
  Person(player, "Player", "Plays local or online matches in a browser")
  Person(operator, "Operator", "Inspects service and game history")
  System(game, "Tic Tac Toe", "React web app and authoritative online game service")
  System_Ext(postgres, "PostgreSQL", "Optional durable room, receipt, profile, rivalry, and history storage")

  Rel(player, game, "Plays and manages a browser profile", "HTTPS / WebSocket")
  Rel(operator, game, "Views protected history dashboard", "HTTPS")
  Rel(game, postgres, "Persists and queries state", "PostgreSQL protocol + TLS when configured")
```

In production, the browser assets, REST endpoints, and Socket.IO transport are
served from the same origin. During development, Vite serves the browser app
and proxies `/health` and `/socket.io` to the Node server; profile and admin API
calls require either a production-style server or a corresponding proxy/setup.

## Container view

```mermaid
C4Container
  title Tic Tac Toe containers
  Person(player, "Player")
  Person(operator, "Operator")

  Container_Boundary(browser, "Browser") {
    Container(web, "React application", "React, TypeScript", "Local game UI, online lobby/match, and admin dashboard")
    ContainerDb(browserStorage, "Browser storage", "sessionStorage / localStorage", "Seat session, pending command, profile credentials, and operator key")
  }

  Container(server, "Game service", "Node.js, Express, Socket.IO", "Serves assets and HTTP APIs; owns live rooms and broadcasts state")
  ContainerDb(memory, "Process memory", "Maps and timers", "Live room authority, socket indexes, rate limits, and in-memory adapters")
  ContainerDb(postgres, "PostgreSQL", "Optional", "Durable active rooms, receipts, profiles, rivalries, and history")

  Rel(player, web, "Uses")
  Rel(operator, web, "Uses /admin")
  Rel(web, browserStorage, "Reads/writes")
  Rel(web, server, "Profile/admin APIs", "HTTPS/JSON")
  Rel(web, server, "Room commands and state", "Socket.IO")
  Rel(server, memory, "Owns live state")
  Rel(server, postgres, "Uses when DATABASE_URL is set", "pg")
```

## Component view

```mermaid
flowchart LR
  subgraph Browser[React browser application]
    App[App and view components]
    Local[useLocalGameSession]
    Remote[useRemoteGameSession]
    Admin[AdminDashboard]
    Protocol[protocol.ts\nZod schemas and event types]
    Rules[engine.ts + match.ts\npure reducers]
    Storage[(Browser storage)]

    App --> Local
    App --> Remote
    App --> Admin
    Local --> Rules
    Remote --> Protocol
    Remote --> Storage
    Admin --> Storage
  end

  subgraph Service[Node game service]
    HTTP[Express routes and static hosting]
    Socket[Socket.IO handlers]
    Manager[RoomManager\nauthoritative rooms]
    Profiles[ProfileService]
    History[HistoryRecorder]
    RoomStore[RoomStateStore]
    ProfileStore[ProfileStore]
    HistoryStore[HistoryStore]

    HTTP --> Profiles
    HTTP --> History
    Socket --> Protocol
    Socket --> Manager
    Socket --> Profiles
    Manager --> Rules
    Manager --> RoomStore
    Manager -. lifecycle events .-> History
    Manager -. completed rounds .-> Profiles
    Profiles --> ProfileStore
    Profiles -. lifecycle events .-> History
    History --> HistoryStore
  end

  Remote <-->|Socket.IO| Socket
  Remote -->|POST profile session| HTTP
  Admin -->|GET protected history| HTTP

  RoomStore --> MemoryOrPg[(Memory or PostgreSQL)]
  ProfileStore --> MemoryOrPg
  HistoryStore --> MemoryOrPg
```

### Responsibilities and boundaries

- **UI components** render state and translate gestures into session actions;
  they do not validate authoritative online moves.
- **Session hooks** adapt local reducers or the remote protocol to the common
  `GameSession` shape used by the main game view.
- **Protocol module** is shared by browser and server. It couples compile-time
  Socket.IO event types with runtime Zod validation at trust boundaries.
- **Game reducers** are deterministic and environment-independent. The server
  reuses them to guarantee the same rules as local play.
- **Game server** owns transport concerns: origin checks, request validation,
  per-socket rate limiting, room membership, HTTP authentication, and startup/
  shutdown orchestration.
- **RoomManager** owns room authorization, seats, reconnect grace periods,
  match transitions, revisions, idempotent command receipts, persistence
  sequencing, and lifecycle callbacks.
- **ProfileService** authenticates hashed browser credentials, updates public
  profile information, and records aggregate and rivalry outcomes.
- **HistoryRecorder** sanitizes and buffers operational events before storage;
  admin reads go through its query methods.
- **Store interfaces** isolate domain services from memory/PostgreSQL adapters.

## Dependency direction

The shared game and protocol modules must not depend on React, Express,
Socket.IO server internals, or PostgreSQL. UI and server code depend inward on
those modules. Domain services depend on storage interfaces, while adapter
factories choose concrete implementations from environment configuration.
This direction keeps reducers unit-testable and lets server integration tests
inject in-memory stores.
