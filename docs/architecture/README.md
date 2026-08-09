# Architecture documentation

This directory describes the architecture implemented by the repository. It
is intended for maintainers changing the client/server protocol, persistence,
deployment topology, or game lifecycle.

## Document map

| Document | Purpose |
| --- | --- |
| [System overview](system-overview.md) | Context, containers, components, responsibilities, and dependency rules. |
| [Runtime flows](runtime-flows.md) | Create/join, move, reconnect, directory synchronization, and startup sequences. |
| [Data and deployment](data-and-deployment.md) | Persistence boundaries, data ownership, security boundaries, deployment topology, and scaling constraints. |

The diagrams use [Mermaid](https://mermaid.js.org/) syntax and render directly
in GitHub. They describe the current implementation rather than a target-state
design.

## Architectural summary

The application is a TypeScript system with two modes:

- **Local mode** executes the pure game and match reducers in the browser.
- **Online mode** treats one Node.js process as the authoritative owner of all
  live rooms. A React hook communicates with it over Socket.IO and consumes
  revisioned snapshots.

The server is an Express and Socket.IO application on one HTTP server. It
validates wire payloads with Zod, delegates state transitions to `RoomManager`,
and publishes resulting snapshots and lobby deltas. Profiles are established
over HTTP before room entry. Administrative history is queried over protected
HTTP endpoints.

Three server subsystems expose storage interfaces: active rooms/command
receipts, profiles/rivalries, and history. Each selects an in-memory adapter
when `DATABASE_URL` is absent and a PostgreSQL adapter when it is present.
PostgreSQL provides durability and restart recovery; it does not coordinate
multiple live room owners.

## Key invariants

1. `src/game/engine.ts` is the pure source of tic-tac-toe rules, and
   `src/game/match.ts` is the pure source of round and score transitions.
2. In online mode, clients request actions; only `RoomManager` mutates the
   authoritative match.
3. Every accepted room mutation increments room state and is exposed through a
   snapshot; directory mutations use a separate ordered revision stream.
4. A reconnect token identifies a room seat and is stored per browser tab in
   session storage. A profile token identifies a casual browser profile and is
   stored in local storage.
5. Passwords and profile tokens are never persisted as plaintext. Room
   snapshots and directory entries expose only public state.
6. Command IDs make retried mutations idempotent for the receipt retention
   window.
7. The production topology must remain at one application instance until room
   authority and Socket.IO fan-out are moved to shared coordination services.

## Change guide

| Change | Primary files | Also verify |
| --- | --- | --- |
| Game rule | `src/game/engine.ts`, `src/game/match.ts` | Engine/match tests, persisted room schema, protocol snapshots, UI messaging. |
| Socket command/event | `src/game/protocol.ts`, `server/game-server.ts`, `src/game/remote-session.ts` | Zod validation, command idempotency, integration tests, protocol version. |
| Room lifecycle | `server/room-manager.ts` | Room persistence, history events, disconnect timers, directory revisions. |
| Profile/rivalry behavior | `server/profiles/`, profile endpoint and client session code | Token handling, rate limiting, history, PostgreSQL migration SQL. |
| History event | `src/history.ts`, `server/history/` | Payload sanitization, summary aggregation, admin dashboard. |
| Deployment topology | `Dockerfile`, `render.yaml`, server store factories | Health reporting, graceful shutdown, single-instance invariant. |

## Architecture decision log

The repository does not yet maintain formal ADR files. When a decision changes
one of the invariants above, add an ADR under `docs/architecture/decisions/`
using a short record of context, decision, consequences, and status, and update
the affected diagrams in the same change.
