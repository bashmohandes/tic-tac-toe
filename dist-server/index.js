// server/game-server.ts
import { timingSafeEqual as timingSafeEqual3 } from "crypto";
import { existsSync } from "fs";
import { createServer as createHttpServer } from "http";
import { resolve } from "path";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";

// src/game/protocol.ts
import { z } from "zod";
var PROTOCOL_VERSION = 4;
var ROOM_CODE_LENGTH = 6;
var PLAYER_NAME_MAX_LENGTH = 24;
var ROOM_NAME_MAX_LENGTH = 32;
var ROOM_PASSWORD_MIN_LENGTH = 6;
var ROOM_PASSWORD_MAX_LENGTH = 64;
var PLAYER_AVATAR_KEYS = [
  "coral",
  "teal",
  "gold",
  "sky",
  "violet",
  "green"
];
var normalizedPlayerNameSchema = z.string().transform((name) => name.trim().replace(/\s+/g, " ")).pipe(
  z.string().min(1, "Enter a display name.").max(
    PLAYER_NAME_MAX_LENGTH,
    `Names can use up to ${PLAYER_NAME_MAX_LENGTH} characters.`
  ).refine(
    (name) => [...name].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    }),
    "Names cannot contain control characters."
  )
);
var profileCredentialsSchema = z.object({
  profileId: z.string().uuid(),
  profileToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "The player profile token is invalid.")
}).strict();
var playerRecordSchema = z.object({
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative()
}).strict();
var publicPlayerProfileSchema = z.object({
  id: z.string().uuid(),
  displayName: normalizedPlayerNameSchema,
  avatarKey: z.enum(PLAYER_AVATAR_KEYS),
  record: playerRecordSchema,
  createdAt: z.string().datetime()
}).strict();
var playerProfileSessionSchema = z.object({
  credentials: profileCredentialsSchema,
  profile: publicPlayerProfileSchema
}).strict();
var profileSessionPayloadSchema = z.object({
  credentials: profileCredentialsSchema.optional(),
  displayName: normalizedPlayerNameSchema.optional(),
  avatarKey: z.enum(PLAYER_AVATAR_KEYS).optional()
}).strict().superRefine((payload, context) => {
  if (!payload.credentials && (!payload.displayName || !payload.avatarKey)) {
    context.addIssue({
      code: "custom",
      message: "Choose a display name and profile color."
    });
  }
  if (payload.displayName && !payload.avatarKey || !payload.displayName && payload.avatarKey) {
    context.addIssue({
      code: "custom",
      message: "Update the display name and profile color together."
    });
  }
});
var commandIdSchema = z.string().uuid();
var createRoomPayloadSchema = z.object({
  commandId: commandIdSchema,
  name: normalizedPlayerNameSchema,
  roomName: z.string().transform((name) => name.trim().replace(/\s+/g, " ")).pipe(
    z.string().min(1, "Enter a room name.").max(
      ROOM_NAME_MAX_LENGTH,
      `Room names can use up to ${ROOM_NAME_MAX_LENGTH} characters.`
    ).refine(
      (name) => [...name].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
      "Room names cannot contain control characters."
    )
  ),
  visibility: z.enum(["public", "private"]),
  password: z.string().max(ROOM_PASSWORD_MAX_LENGTH).optional(),
  profile: profileCredentialsSchema.optional()
}).strict().superRefine((room, context) => {
  if (room.visibility === "private" && (!room.password || room.password.length < ROOM_PASSWORD_MIN_LENGTH)) {
    context.addIssue({
      code: "custom",
      message: `Passwords need at least ${ROOM_PASSWORD_MIN_LENGTH} characters.`,
      path: ["password"]
    });
  }
});
var joinRoomPayloadSchema = z.object({
  commandId: commandIdSchema,
  name: normalizedPlayerNameSchema,
  roomCode: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{6}$/, "Enter a valid six-character room code."),
  password: z.string().max(ROOM_PASSWORD_MAX_LENGTH).optional(),
  profile: profileCredentialsSchema.optional()
}).strict();
var roomSessionPayloadSchema = z.object({
  commandId: commandIdSchema,
  roomCode: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{6}$/),
  sessionToken: z.string().uuid()
}).strict();
var roomCommandPayloadSchema = roomSessionPayloadSchema.extend({
  revision: z.number().int().nonnegative()
});
var playMovePayloadSchema = roomCommandPayloadSchema.extend({
  index: z.number().int().min(0).max(8)
});
var leaveRoomPayloadSchema = roomCommandPayloadSchema.omit({
  revision: true
});
var sessionIdentitySchema = z.object({
  roomCode: joinRoomPayloadSchema.shape.roomCode,
  sessionToken: z.string().uuid(),
  player: z.enum(["X", "O"]),
  name: normalizedPlayerNameSchema,
  profileId: z.string().uuid()
}).strict();

// server/history/summary.ts
function summarizeEvents(events, from, to) {
  const counts = {
    roomsCreated: 0,
    matchesStarted: 0,
    roundsCompleted: 0,
    movesPlayed: 0,
    playersJoined: 0,
    joinRejections: 0,
    disconnects: 0,
    reconnects: 0
  };
  const outcomes = {
    xWins: 0,
    oWins: 0,
    draws: 0
  };
  for (const event of events) {
    switch (event.type) {
      case "room_created":
        counts.roomsCreated += 1;
        break;
      case "match_started":
        counts.matchesStarted += 1;
        break;
      case "round_completed":
        counts.roundsCompleted += 1;
        if (event.payload.outcome === "X") {
          outcomes.xWins += 1;
        } else if (event.payload.outcome === "O") {
          outcomes.oWins += 1;
        } else if (event.payload.outcome === "draw") {
          outcomes.draws += 1;
        }
        break;
      case "move_played":
        counts.movesPlayed += 1;
        break;
      case "player_joined":
        counts.playersJoined += 1;
        break;
      case "join_rejected":
        counts.joinRejections += 1;
        break;
      case "player_disconnected":
        counts.disconnects += 1;
        break;
      case "player_reconnected":
        counts.reconnects += 1;
        break;
      default:
        break;
    }
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    counts,
    outcomes
  };
}

// server/history/in-memory-store.ts
var InMemoryHistoryStore = class {
  backend = "memory";
  events = [];
  eventIds = /* @__PURE__ */ new Set();
  async initialize() {
  }
  async append(events) {
    for (const event of events) {
      if (!this.eventIds.has(event.eventId)) {
        this.eventIds.add(event.eventId);
        this.events.push(event);
      }
    }
  }
  async getEvents(query) {
    const fromTime = query.from.getTime();
    const beforeTime = query.before?.getTime() ?? Number.POSITIVE_INFINITY;
    return this.events.map((event, insertionOrder) => ({ event, insertionOrder })).filter(({ event }) => {
      const eventTime = Date.parse(event.occurredAt);
      return eventTime >= fromTime && eventTime < beforeTime;
    }).sort(
      (first, second) => Date.parse(second.event.occurredAt) - Date.parse(first.event.occurredAt) || second.insertionOrder - first.insertionOrder
    ).slice(0, query.limit).map(({ event }) => event);
  }
  async getSummary(from, to) {
    const fromTime = from.getTime();
    const toTime = to.getTime();
    const events = this.events.filter((event) => {
      const eventTime = Date.parse(event.occurredAt);
      return eventTime >= fromTime && eventTime <= toTime;
    });
    return summarizeEvents(events, from, to);
  }
  async close() {
  }
};

// server/history/postgres-store.ts
import { Pool } from "pg";
function toCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}
function toHistoryEvent(row) {
  return {
    eventId: row.event_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.event_type,
    roomId: row.room_id,
    matchId: row.match_id,
    instanceId: row.instance_id,
    releaseId: row.release_id,
    payload: row.payload,
    schemaVersion: row.schema_version
  };
}
var PostgresHistoryStore = class {
  backend = "postgres";
  pool;
  retentionDays;
  constructor(options) {
    const poolConfig = {
      connectionString: options.connectionString,
      application_name: "tic-tac-toe-history",
      max: 5
    };
    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    this.pool = new Pool(poolConfig);
    this.retentionDays = Math.max(0, options.retentionDays ?? 365);
  }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS game_history_events (
        id BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL UNIQUE,
        occurred_at TIMESTAMPTZ NOT NULL,
        event_type TEXT NOT NULL,
        room_id UUID,
        match_id UUID,
        instance_id TEXT NOT NULL,
        release_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        schema_version SMALLINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS game_history_events_occurred_at_idx
        ON game_history_events (occurred_at DESC);
      CREATE INDEX IF NOT EXISTS game_history_events_room_idx
        ON game_history_events (room_id, occurred_at DESC)
        WHERE room_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS game_history_events_match_idx
        ON game_history_events (match_id, occurred_at ASC)
        WHERE match_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS game_history_events_type_idx
        ON game_history_events (event_type, occurred_at DESC);
    `);
    if (this.retentionDays > 0) {
      await this.pool.query(
        `
          DELETE FROM game_history_events
          WHERE occurred_at < NOW() - ($1 * INTERVAL '1 day')
        `,
        [this.retentionDays]
      );
    }
  }
  async append(events) {
    if (events.length === 0) {
      return;
    }
    const values = [];
    const rows = events.map((event, index) => {
      const offset = index * 9;
      values.push(
        event.eventId,
        event.occurredAt,
        event.type,
        event.roomId,
        event.matchId,
        event.instanceId,
        event.releaseId,
        JSON.stringify(event.payload),
        event.schemaVersion
      );
      return `(
        $${offset + 1}, $${offset + 2}, $${offset + 3},
        $${offset + 4}, $${offset + 5}, $${offset + 6},
        $${offset + 7}, $${offset + 8}::jsonb, $${offset + 9}
      )`;
    });
    await this.pool.query(
      `
        INSERT INTO game_history_events (
          event_id,
          occurred_at,
          event_type,
          room_id,
          match_id,
          instance_id,
          release_id,
          payload,
          schema_version
        )
        VALUES ${rows.join(",")}
        ON CONFLICT (event_id) DO NOTHING
      `,
      values
    );
  }
  async getEvents(query) {
    const values = [query.from.toISOString()];
    let beforeClause = "";
    if (query.before) {
      values.push(query.before.toISOString());
      beforeClause = `AND occurred_at < $${values.length}`;
    }
    values.push(query.limit);
    const result = await this.pool.query(
      `
        SELECT
          event_id,
          occurred_at,
          event_type,
          room_id,
          match_id,
          instance_id,
          release_id,
          payload,
          schema_version
        FROM game_history_events
        WHERE occurred_at >= $1
          ${beforeClause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${values.length}
      `,
      values
    );
    return result.rows.map(toHistoryEvent);
  }
  async getSummary(from, to) {
    const result = await this.pool.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE event_type = 'room_created'
          ) AS rooms_created,
          COUNT(*) FILTER (
            WHERE event_type = 'match_started'
          ) AS matches_started,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
          ) AS rounds_completed,
          COUNT(*) FILTER (
            WHERE event_type = 'move_played'
          ) AS moves_played,
          COUNT(*) FILTER (
            WHERE event_type = 'player_joined'
          ) AS players_joined,
          COUNT(*) FILTER (
            WHERE event_type = 'join_rejected'
          ) AS join_rejections,
          COUNT(*) FILTER (
            WHERE event_type = 'player_disconnected'
          ) AS disconnects,
          COUNT(*) FILTER (
            WHERE event_type = 'player_reconnected'
          ) AS reconnects,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'X'
          ) AS x_wins,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'O'
          ) AS o_wins,
          COUNT(*) FILTER (
            WHERE event_type = 'round_completed'
              AND payload->>'outcome' = 'draw'
          ) AS draws
        FROM game_history_events
        WHERE occurred_at >= $1
          AND occurred_at <= $2
      `,
      [from.toISOString(), to.toISOString()]
    );
    const row = result.rows[0] ?? {};
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      counts: {
        roomsCreated: toCount(row.rooms_created),
        matchesStarted: toCount(row.matches_started),
        roundsCompleted: toCount(row.rounds_completed),
        movesPlayed: toCount(row.moves_played),
        playersJoined: toCount(row.players_joined),
        joinRejections: toCount(row.join_rejections),
        disconnects: toCount(row.disconnects),
        reconnects: toCount(row.reconnects)
      },
      outcomes: {
        xWins: toCount(row.x_wins),
        oWins: toCount(row.o_wins),
        draws: toCount(row.draws)
      }
    };
  }
  async close() {
    await this.pool.end();
  }
};

// server/history/create-history.ts
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function createHistoryStore(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    return new InMemoryHistoryStore();
  }
  return new PostgresHistoryStore({
    connectionString: databaseUrl,
    retentionDays: positiveInteger(
      environment.HISTORY_RETENTION_DAYS,
      365
    ),
    requireSsl: environment.DATABASE_SSL === "require"
  });
}
function deploymentIdentity(environment = process.env) {
  const instanceId = environment.SERVICE_INSTANCE_ID ?? environment.RENDER_INSTANCE_ID ?? environment.FLY_ALLOC_ID ?? environment.RAILWAY_REPLICA_ID;
  const releaseId = environment.RELEASE_SHA ?? environment.RENDER_GIT_COMMIT ?? environment.FLY_IMAGE_REF ?? environment.RAILWAY_DEPLOYMENT_ID;
  return {
    ...instanceId ? { instanceId } : {},
    ...releaseId ? { releaseId } : {}
  };
}

// server/history/recorder.ts
import { randomUUID } from "crypto";

// src/history.ts
var HISTORY_SCHEMA_VERSION = 1;

// server/history/recorder.ts
var DEFAULT_FLUSH_INTERVAL_MS = 250;
var MAX_BUFFERED_EVENTS = 1e4;
var SENSITIVE_KEYS = /* @__PURE__ */ new Set([
  "adminapikey",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "databaseurl",
  "hash",
  "password",
  "passwordhash",
  "privatekey",
  "reconnecttoken",
  "roomcode",
  "salt",
  "secret",
  "sessiontoken",
  "socketid",
  "token"
]);
function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!SENSITIVE_KEYS.has(normalizedKey(key))) {
        sanitized[key] = sanitizeValue(nestedValue);
      }
    }
    return sanitized;
  }
  return value;
}
function sanitizeHistoryPayload(payload) {
  return sanitizeValue(payload);
}
var HistoryRecorder = class {
  backend;
  store;
  instanceId;
  releaseId;
  flushIntervalMs;
  now;
  queue = [];
  timer = null;
  writeChain = Promise.resolve();
  initialized = false;
  closed = false;
  currentStatus = "starting";
  constructor(store, options = {}) {
    this.store = store;
    this.backend = store.backend;
    this.instanceId = options.instanceId ?? randomUUID();
    this.releaseId = options.releaseId ?? null;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
  }
  get status() {
    return this.currentStatus;
  }
  async initialize() {
    if (this.initialized) {
      return;
    }
    await this.store.initialize();
    this.initialized = true;
    this.currentStatus = "ready";
  }
  record(draft) {
    if (this.closed) {
      return;
    }
    const event = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      type: draft.type,
      roomId: draft.roomId ?? null,
      matchId: draft.matchId ?? null,
      instanceId: this.instanceId,
      releaseId: this.releaseId,
      payload: sanitizeHistoryPayload(draft.payload ?? {}),
      schemaVersion: HISTORY_SCHEMA_VERSION
    };
    this.queue.push(event);
    if (this.queue.length > MAX_BUFFERED_EVENTS) {
      this.queue.splice(0, this.queue.length - MAX_BUFFERED_EVENTS);
      console.error("History buffer reached its limit; oldest events dropped.");
    }
    if (this.queue.length >= 100) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }
  async flush() {
    this.clearTimer();
    this.writeChain = this.writeChain.then(async () => {
      if (!this.initialized) {
        return;
      }
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 100);
        try {
          await this.store.append(batch);
          this.currentStatus = "ready";
        } catch (error) {
          this.queue.unshift(...batch);
          this.currentStatus = "degraded";
          console.error("History write failed; events remain buffered.", error);
          break;
        }
      }
      if (this.queue.length > 0 && !this.closed) {
        this.scheduleFlush(
          this.currentStatus === "degraded" ? 2e3 : this.flushIntervalMs
        );
      }
    });
    await this.writeChain;
  }
  async getSummary(hours) {
    await this.flush();
    const to = this.now();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1e3);
    return this.store.getSummary(from, to);
  }
  async getEvents(hours, limit, before) {
    await this.flush();
    const to = this.now();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1e3);
    const events = await this.store.getEvents({
      from,
      before,
      limit: limit + 1
    });
    return {
      events: events.slice(0, limit),
      hasMore: events.length > limit
    };
  }
  async close() {
    if (this.closed) {
      return;
    }
    this.clearTimer();
    await this.flush();
    this.closed = true;
    this.clearTimer();
    this.currentStatus = "closed";
    await this.store.close();
  }
  scheduleFlush(delay = this.flushIntervalMs) {
    if (this.timer || this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }
  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
};

// server/profiles/in-memory-store.ts
function rivalryKey(firstId, secondId) {
  return firstId < secondId ? {
    key: `${firstId}:${secondId}`,
    firstIsA: true
  } : {
    key: `${secondId}:${firstId}`,
    firstIsA: false
  };
}
var InMemoryProfileStore = class {
  backend = "memory";
  profiles = /* @__PURE__ */ new Map();
  rivalries = /* @__PURE__ */ new Map();
  async initialize() {
  }
  async create(profile) {
    const stored = {
      ...profile,
      record: {
        wins: 0,
        losses: 0,
        draws: 0
      }
    };
    this.profiles.set(stored.id, stored);
    return structuredClone(stored);
  }
  async find(profileId) {
    const profile = this.profiles.get(profileId);
    return profile ? structuredClone(profile) : null;
  }
  async update(profileId, displayName, avatarKey) {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error("Player profile not found");
    }
    const updated = {
      ...profile,
      displayName,
      avatarKey
    };
    this.profiles.set(profileId, updated);
    return structuredClone(updated);
  }
  async getRivalry(xProfileId, oProfileId) {
    const { key, firstIsA } = rivalryKey(xProfileId, oProfileId);
    const rivalry = this.rivalries.get(key) ?? {
      aWins: 0,
      bWins: 0,
      draws: 0
    };
    return {
      xWins: firstIsA ? rivalry.aWins : rivalry.bWins,
      oWins: firstIsA ? rivalry.bWins : rivalry.aWins,
      draws: rivalry.draws
    };
  }
  async recordRound(xProfileId, oProfileId, outcome) {
    const xProfile = this.profiles.get(xProfileId);
    const oProfile = this.profiles.get(oProfileId);
    if (!xProfile || !oProfile) {
      throw new Error("Round profiles not found");
    }
    if (outcome === "draw") {
      this.profiles.set(xProfileId, {
        ...xProfile,
        record: {
          ...xProfile.record,
          draws: xProfile.record.draws + 1
        }
      });
      this.profiles.set(oProfileId, {
        ...oProfile,
        record: {
          ...oProfile.record,
          draws: oProfile.record.draws + 1
        }
      });
    } else {
      const winnerId = outcome === "X" ? xProfileId : oProfileId;
      const loserId = outcome === "X" ? oProfileId : xProfileId;
      const winner = this.profiles.get(winnerId);
      const loser = this.profiles.get(loserId);
      if (!winner || !loser) {
        throw new Error("Round profiles not found");
      }
      this.profiles.set(winnerId, {
        ...winner,
        record: {
          ...winner.record,
          wins: winner.record.wins + 1
        }
      });
      this.profiles.set(loserId, {
        ...loser,
        record: {
          ...loser.record,
          losses: loser.record.losses + 1
        }
      });
    }
    const { key, firstIsA } = rivalryKey(xProfileId, oProfileId);
    const rivalry = this.rivalries.get(key) ?? {
      aWins: 0,
      bWins: 0,
      draws: 0
    };
    const aWon = outcome === "X" && firstIsA || outcome === "O" && !firstIsA;
    const bWon = outcome === "X" && !firstIsA || outcome === "O" && firstIsA;
    this.rivalries.set(key, {
      aWins: rivalry.aWins + (aWon ? 1 : 0),
      bWins: rivalry.bWins + (bWon ? 1 : 0),
      draws: rivalry.draws + (outcome === "draw" ? 1 : 0)
    });
  }
  async close() {
  }
};

// server/profiles/postgres-store.ts
import { Pool as Pool2 } from "pg";
function toProfile(row) {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    record: {
      wins: Number(row.wins),
      losses: Number(row.losses),
      draws: Number(row.draws)
    },
    createdAt: new Date(row.created_at).toISOString()
  };
}
function canonicalPair(firstId, secondId) {
  return firstId < secondId ? {
    profileA: firstId,
    profileB: secondId,
    firstIsA: true
  } : {
    profileA: secondId,
    profileB: firstId,
    firstIsA: false
  };
}
var PostgresProfileStore = class {
  backend = "postgres";
  pool;
  constructor(options) {
    const poolConfig = {
      connectionString: options.connectionString,
      application_name: "tic-tac-toe-profiles",
      max: 3
    };
    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    this.pool = new Pool2(poolConfig);
  }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS player_profiles (
        id UUID PRIMARY KEY,
        token_hash CHAR(64) NOT NULL,
        display_name VARCHAR(24) NOT NULL,
        avatar_key VARCHAR(16) NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
        draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS player_rivalries (
        profile_a UUID NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
        profile_b UUID NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
        a_wins INTEGER NOT NULL DEFAULT 0 CHECK (a_wins >= 0),
        b_wins INTEGER NOT NULL DEFAULT 0 CHECK (b_wins >= 0),
        draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profile_a, profile_b),
        CHECK (profile_a <> profile_b)
      );
    `);
  }
  async create(profile) {
    const result = await this.pool.query(
      `
        INSERT INTO player_profiles (
          id,
          token_hash,
          display_name,
          avatar_key,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
      `,
      [
        profile.id,
        profile.tokenHash,
        profile.displayName,
        profile.avatarKey,
        profile.createdAt
      ]
    );
    return toProfile(result.rows[0]);
  }
  async find(profileId) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
        FROM player_profiles
        WHERE id = $1
      `,
      [profileId]
    );
    const row = result.rows[0];
    return row ? toProfile(row) : null;
  }
  async update(profileId, displayName, avatarKey) {
    const result = await this.pool.query(
      `
        UPDATE player_profiles
        SET
          display_name = $2,
          avatar_key = $3,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          token_hash,
          display_name,
          avatar_key,
          wins,
          losses,
          draws,
          created_at
      `,
      [profileId, displayName, avatarKey]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Player profile not found");
    }
    return toProfile(row);
  }
  async getRivalry(xProfileId, oProfileId) {
    const pair = canonicalPair(xProfileId, oProfileId);
    const result = await this.pool.query(
      `
        SELECT a_wins, b_wins, draws
        FROM player_rivalries
        WHERE profile_a = $1 AND profile_b = $2
      `,
      [pair.profileA, pair.profileB]
    );
    const row = result.rows[0] ?? {
      a_wins: 0,
      b_wins: 0,
      draws: 0
    };
    return {
      xWins: pair.firstIsA ? Number(row.a_wins) : Number(row.b_wins),
      oWins: pair.firstIsA ? Number(row.b_wins) : Number(row.a_wins),
      draws: Number(row.draws)
    };
  }
  async recordRound(xProfileId, oProfileId, outcome) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.updateProfileRecords(
        client,
        xProfileId,
        oProfileId,
        outcome
      );
      const pair = canonicalPair(xProfileId, oProfileId);
      const aWon = outcome === "X" && pair.firstIsA || outcome === "O" && !pair.firstIsA;
      const bWon = outcome === "X" && !pair.firstIsA || outcome === "O" && pair.firstIsA;
      await client.query(
        `
          INSERT INTO player_rivalries (
            profile_a,
            profile_b,
            a_wins,
            b_wins,
            draws
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (profile_a, profile_b)
          DO UPDATE SET
            a_wins = player_rivalries.a_wins + EXCLUDED.a_wins,
            b_wins = player_rivalries.b_wins + EXCLUDED.b_wins,
            draws = player_rivalries.draws + EXCLUDED.draws,
            updated_at = NOW()
        `,
        [
          pair.profileA,
          pair.profileB,
          aWon ? 1 : 0,
          bWon ? 1 : 0,
          outcome === "draw" ? 1 : 0
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
  async updateProfileRecords(client, xProfileId, oProfileId, outcome) {
    if (outcome === "draw") {
      await client.query(
        `
          UPDATE player_profiles
          SET draws = draws + 1, updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `,
        [[xProfileId, oProfileId]]
      );
      return;
    }
    const winnerId = outcome === "X" ? xProfileId : oProfileId;
    const loserId = outcome === "X" ? oProfileId : xProfileId;
    await client.query(
      `
        UPDATE player_profiles
        SET wins = wins + 1, updated_at = NOW()
        WHERE id = $1
      `,
      [winnerId]
    );
    await client.query(
      `
        UPDATE player_profiles
        SET losses = losses + 1, updated_at = NOW()
        WHERE id = $1
      `,
      [loserId]
    );
  }
};

// server/profiles/create-profile-store.ts
function createProfileStore(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    return new InMemoryProfileStore();
  }
  return new PostgresProfileStore({
    connectionString: databaseUrl,
    requireSsl: environment.DATABASE_SSL === "require"
  });
}

// server/profiles/profile-service.ts
import {
  createHash,
  randomBytes,
  randomUUID as randomUUID2,
  timingSafeEqual
} from "crypto";
var InvalidProfileError = class extends Error {
};
function publicProfile(profile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    avatarKey: profile.avatarKey,
    record: profile.record,
    createdAt: profile.createdAt
  };
}
var ProfileService = class {
  backend;
  store;
  now;
  onHistoryEvent;
  initialized = false;
  closed = false;
  currentStatus = "starting";
  constructor(store, options = {}) {
    this.store = store;
    this.backend = store.backend;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.onHistoryEvent = options.onHistoryEvent ?? (() => void 0);
  }
  get status() {
    return this.currentStatus;
  }
  async initialize() {
    if (this.initialized) {
      return;
    }
    await this.store.initialize();
    this.initialized = true;
    this.currentStatus = "ready";
  }
  async ensureSession(payload) {
    if (!payload.credentials) {
      if (!payload.displayName || !payload.avatarKey) {
        throw new InvalidProfileError("Profile details are required.");
      }
      return this.create(payload.displayName, payload.avatarKey);
    }
    const profile = await this.authenticate(payload.credentials);
    if (payload.displayName && payload.avatarKey && (profile.displayName !== payload.displayName || profile.avatarKey !== payload.avatarKey)) {
      const updated = await this.store.update(
        profile.id,
        payload.displayName,
        payload.avatarKey
      );
      this.onHistoryEvent({
        type: "profile_updated",
        payload: {
          avatarKey: updated.avatarKey,
          displayName: updated.displayName,
          profileId: updated.id
        }
      });
      return {
        credentials: payload.credentials,
        profile: publicProfile(updated)
      };
    }
    return {
      credentials: payload.credentials,
      profile
    };
  }
  async authenticate(credentials) {
    const stored = await this.store.find(credentials.profileId);
    if (!stored || !this.hashesMatch(
      this.hashToken(credentials.profileToken),
      stored.tokenHash
    )) {
      throw new InvalidProfileError("The saved player profile is invalid.");
    }
    return publicProfile(stored);
  }
  async getRivalry(xProfileId, oProfileId) {
    return this.store.getRivalry(xProfileId, oProfileId);
  }
  async recordRound(xProfileId, oProfileId, outcome) {
    try {
      await this.store.recordRound(xProfileId, oProfileId, outcome);
      this.currentStatus = "ready";
    } catch (error) {
      this.currentStatus = "degraded";
      throw error;
    }
  }
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.currentStatus = "closed";
    await this.store.close();
  }
  async create(displayName, avatarKey) {
    const profileToken = randomBytes(32).toString("base64url");
    const stored = await this.store.create({
      id: randomUUID2(),
      tokenHash: this.hashToken(profileToken),
      displayName,
      avatarKey,
      createdAt: this.now().toISOString()
    });
    const credentials = {
      profileId: stored.id,
      profileToken
    };
    this.onHistoryEvent({
      type: "profile_created",
      payload: {
        avatarKey: stored.avatarKey,
        displayName: stored.displayName,
        profileId: stored.id
      }
    });
    return {
      credentials,
      profile: publicProfile(stored)
    };
  }
  hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
  }
  hashesMatch(first, second) {
    const firstBytes = Buffer.from(first);
    const secondBytes = Buffer.from(second);
    return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
  }
};

// server/room-manager.ts
import {
  createHash as createHash2,
  randomBytes as randomBytes2,
  randomInt,
  randomUUID as randomUUID3,
  scrypt,
  timingSafeEqual as timingSafeEqual2
} from "crypto";
import { promisify } from "util";

// src/game/engine.ts
var WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];
var BOARD_SIZE = 9;
function otherPlayer(player) {
  return player === "X" ? "O" : "X";
}
function createRound(startingPlayer = "X") {
  return {
    board: Array(BOARD_SIZE).fill(null),
    currentPlayer: startingPlayer,
    startingPlayer,
    status: "playing",
    winner: null,
    winningLine: null,
    moveCount: 0
  };
}
function getWinningLine(board) {
  for (const line of WINNING_LINES) {
    const [first, second, third] = line;
    const player = board[first];
    if (player && player === board[second] && player === board[third]) {
      return line;
    }
  }
  return null;
}
function playMove(state, index) {
  const moveIsInvalid = !Number.isInteger(index) || index < 0 || index >= BOARD_SIZE || state.status !== "playing" || state.board[index] !== null;
  if (moveIsInvalid) {
    return state;
  }
  const board = [...state.board];
  board[index] = state.currentPlayer;
  const moveCount = state.moveCount + 1;
  const winningLine = getWinningLine(board);
  if (winningLine) {
    return {
      ...state,
      board,
      status: "won",
      winner: state.currentPlayer,
      winningLine,
      moveCount
    };
  }
  if (moveCount === BOARD_SIZE) {
    return {
      ...state,
      board,
      status: "draw",
      moveCount
    };
  }
  return {
    ...state,
    board,
    currentPlayer: otherPlayer(state.currentPlayer),
    moveCount
  };
}

// src/game/match.ts
function createMatchState() {
  return {
    round: createRound(),
    roundNumber: 1,
    scores: {
      X: 0,
      O: 0,
      draws: 0
    }
  };
}
function scoreCompletedRound(scores, round) {
  if (round.status === "draw") {
    return {
      ...scores,
      draws: scores.draws + 1
    };
  }
  if (round.status === "won" && round.winner) {
    return {
      ...scores,
      [round.winner]: scores[round.winner] + 1
    };
  }
  return scores;
}
function createNextRound(state) {
  const nextStarter = otherPlayer(state.round.startingPlayer);
  return {
    ...state,
    round: createRound(nextStarter),
    roundNumber: state.roundNumber + 1
  };
}
function matchReducer(state, action) {
  switch (action.type) {
    case "play": {
      const round = playMove(state.round, action.index);
      if (round === state.round) {
        return state;
      }
      return {
        ...state,
        round,
        scores: round.status === "playing" ? state.scores : scoreCompletedRound(state.scores, round)
      };
    }
    case "restart-round":
      if (state.round.status !== "playing" || state.round.moveCount === 0) {
        return state;
      }
      return {
        ...state,
        round: createRound(state.round.startingPlayer)
      };
    case "next-round":
      return state.round.status === "playing" ? state : createNextRound(state);
    case "reset-match":
      return createMatchState();
  }
}

// server/rooms/in-memory-store.ts
var InMemoryRoomStateStore = class {
  backend = "memory";
  rooms = /* @__PURE__ */ new Map();
  receipts = /* @__PURE__ */ new Map();
  nextReceiptCleanupAt = 0;
  async initialize() {
  }
  async loadActiveRooms(now) {
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.rooms.delete(roomId);
      }
    }
    return [...this.rooms.values()].map((room) => structuredClone(room));
  }
  async findReceipt(key, now) {
    if (now >= this.nextReceiptCleanupAt) {
      for (const [receiptKey, candidate] of this.receipts) {
        if (candidate.expiresAt <= now) {
          this.receipts.delete(receiptKey);
        }
      }
      this.nextReceiptCleanupAt = now + 6e4;
    }
    const receipt = this.receipts.get(key);
    if (!receipt) {
      return null;
    }
    if (receipt.expiresAt <= now) {
      this.receipts.delete(key);
      return null;
    }
    return structuredClone(receipt.response);
  }
  async commit(mutation) {
    if (mutation.deleteRoomId) {
      this.rooms.delete(mutation.deleteRoomId);
    }
    if (mutation.upsert) {
      this.rooms.set(
        mutation.upsert.id,
        structuredClone(mutation.upsert)
      );
    }
    if (mutation.receipt) {
      this.receipts.set(
        mutation.receipt.key,
        structuredClone(mutation.receipt)
      );
    }
  }
  async close() {
  }
};

// server/rooms/store.ts
import { z as z2 } from "zod";
var ROOM_STATE_SCHEMA_VERSION = 1;
var playerSchema = z2.enum(["X", "O"]);
var cellSchema = playerSchema.nullable();
var winningLineSchema = z2.tuple([
  z2.number().int().min(0).max(8),
  z2.number().int().min(0).max(8),
  z2.number().int().min(0).max(8)
]).nullable();
var matchStateSchema = z2.object({
  round: z2.object({
    board: z2.array(cellSchema).length(9),
    currentPlayer: playerSchema,
    startingPlayer: playerSchema,
    status: z2.enum(["playing", "won", "draw"]),
    winner: playerSchema.nullable(),
    winningLine: winningLineSchema,
    moveCount: z2.number().int().min(0).max(9)
  }).strict(),
  roundNumber: z2.number().int().positive(),
  scores: z2.object({
    X: z2.number().int().nonnegative(),
    O: z2.number().int().nonnegative(),
    draws: z2.number().int().nonnegative()
  }).strict()
}).strict();
var rivalrySchema = z2.object({
  xWins: z2.number().int().nonnegative(),
  oWins: z2.number().int().nonnegative(),
  draws: z2.number().int().nonnegative()
}).strict().nullable();
var passwordRecordSchema = z2.object({
  saltBase64: z2.string().min(1),
  hashBase64: z2.string().min(1)
}).strict().nullable();
var persistedRoomPlayerSchema = z2.object({
  id: z2.string().uuid(),
  mark: playerSchema,
  name: normalizedPlayerNameSchema,
  profile: publicPlayerProfileSchema,
  persistentProfile: z2.boolean(),
  sessionToken: z2.string().uuid(),
  connected: z2.boolean(),
  disconnectExpiresAt: z2.number().int().nonnegative().nullable()
}).strict();
var persistedRoomSchema = z2.object({
  schemaVersion: z2.literal(ROOM_STATE_SCHEMA_VERSION),
  id: z2.string().uuid(),
  code: z2.string().regex(
    new RegExp(`^[A-HJ-NP-Z2-9]{${ROOM_CODE_LENGTH}}$`)
  ),
  name: z2.string().min(1).max(ROOM_NAME_MAX_LENGTH),
  visibility: z2.enum(["public", "private"]),
  password: passwordRecordSchema,
  matchId: z2.string().uuid().nullable(),
  match: matchStateSchema,
  rivalry: rivalrySchema,
  revision: z2.number().int().nonnegative(),
  players: z2.object({
    X: persistedRoomPlayerSchema,
    O: persistedRoomPlayerSchema.optional()
  }).strict(),
  readyForNextRound: z2.array(playerSchema).max(2),
  lastActivityAt: z2.number().int().nonnegative(),
  expiresAt: z2.number().int().nonnegative()
}).strict().superRefine((room, context) => {
  if (room.players.X.mark !== "X" || room.players.O?.mark === "X") {
    context.addIssue({
      code: "custom",
      message: "Stored room seats do not match their player marks."
    });
  }
});

// server/room-manager.ts
var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var DEFAULT_DISCONNECT_GRACE_MS = 6e4;
var DEFAULT_ROOM_TTL_MS = 6 * 60 * 60 * 1e3;
var MAX_ROOMS = 1e4;
var PASSWORD_KEY_LENGTH = 32;
var COMMAND_RECEIPT_TTL_MS = 10 * 6e4;
var scryptAsync = promisify(scrypt);
function roomError(code, message) {
  return { code, message };
}
function failedCommand(error, snapshot) {
  return {
    ok: false,
    error,
    ...snapshot ? { snapshot } : {}
  };
}
var RoomManager = class {
  backend;
  rooms = /* @__PURE__ */ new Map();
  socketIndex = /* @__PURE__ */ new Map();
  disconnectGraceMs;
  roomTtlMs;
  now;
  onSnapshot;
  onRoomClosed;
  onDirectoryDelta;
  onHistoryEvent;
  onProfileRoundCompleted;
  roomStore;
  commandReceipts = /* @__PURE__ */ new Map();
  commandLocks = /* @__PURE__ */ new Map();
  persistenceQueues = /* @__PURE__ */ new Map();
  directoryRevision = 0;
  currentStatus = "starting";
  initialized = false;
  closed = false;
  constructor(options = {}) {
    this.disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
    this.roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onSnapshot = options.onSnapshot ?? (() => void 0);
    this.onRoomClosed = options.onRoomClosed ?? (() => void 0);
    this.onDirectoryDelta = options.onDirectoryDelta ?? (() => void 0);
    this.onHistoryEvent = options.onHistoryEvent ?? (() => void 0);
    this.onProfileRoundCompleted = options.onProfileRoundCompleted ?? (() => void 0);
    this.roomStore = options.roomStore ?? new InMemoryRoomStateStore();
    this.backend = this.roomStore.backend;
  }
  get roomCount() {
    return this.rooms.size;
  }
  get status() {
    return this.currentStatus;
  }
  async initialize() {
    if (this.initialized) {
      return;
    }
    await this.roomStore.initialize();
    const storedRooms = await this.roomStore.loadActiveRooms(this.now());
    for (const stored of storedRooms) {
      const room = this.restoreRoom(stored);
      if (!room) {
        await this.persistMutation({ deleteRoomId: stored.id });
        continue;
      }
      this.rooms.set(room.code, room);
      await this.persistMutation({ upsert: this.persistedRoom(room) });
      this.schedulePlayerExpirations(room);
      this.record({
        type: "room_recovered",
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          playerCount: Object.values(room.players).filter(Boolean).length,
          revision: room.revision
        }
      });
    }
    this.initialized = true;
    this.currentStatus = "ready";
  }
  getHostProfileId(roomCode) {
    const host2 = this.rooms.get(roomCode)?.players.X;
    return host2?.persistentProfile ? host2.id : null;
  }
  async getDirectory() {
    await this.removeExpiredRooms();
    return {
      rooms: this.buildDirectory(),
      revision: this.directoryRevision
    };
  }
  buildDirectory() {
    return [...this.rooms.values()].map((room) => this.directoryEntry(room)).sort(
      (first, second) => first.roomName.localeCompare(second.roomName) || first.roomCode.localeCompare(second.roomCode)
    );
  }
  directoryEntry(room) {
    return {
      roomCode: room.code,
      roomName: room.name,
      visibility: room.visibility,
      hostName: room.players.X?.name ?? "Host",
      hostProfile: structuredClone(
        room.players.X?.profile ?? this.transientProfile("Host", "X")
      ),
      hostConnected: room.players.X?.connected ?? false,
      playerCount: Object.values(room.players).filter(Boolean).length,
      capacity: 2
    };
  }
  async createRoom(details, socketId) {
    await this.removeExpiredRooms();
    const commandKey = this.commandKey(
      "room:create",
      details.commandId,
      details.profile?.id ?? socketId
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey);
      }
      if (this.socketIndex.has(socketId)) {
        return {
          ok: false,
          error: roomError(
            "ALREADY_IN_ROOM",
            "Leave the current room before creating another one."
          )
        };
      }
      const password = details.visibility === "private" && details.password ? await this.hashPassword(details.password) : null;
      await this.removeExpiredRooms();
      if (this.socketIndex.has(socketId)) {
        return {
          ok: false,
          error: roomError(
            "ALREADY_IN_ROOM",
            "Leave the current room before creating another one."
          )
        };
      }
      if (this.rooms.size >= MAX_ROOMS) {
        return {
          ok: false,
          error: roomError(
            "ROOM_CLOSED",
            "The server has reached its active-room limit."
          )
        };
      }
      const code = this.createRoomCode();
      const player = this.createPlayer(
        "X",
        details.name,
        socketId,
        details.profile
      );
      const room = {
        id: randomUUID3(),
        code,
        name: details.roomName,
        visibility: details.visibility,
        password,
        matchId: null,
        match: createMatchState(),
        rivalry: null,
        revision: 1,
        players: { X: player },
        readyForNextRound: /* @__PURE__ */ new Set(),
        lastActivityAt: this.now()
      };
      this.rooms.set(code, room);
      this.socketIndex.set(socketId, { roomCode: code, player: "X" });
      const response = this.joinSuccess(room, player);
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.record({
        type: "room_created",
        roomId: room.id,
        payload: {
          roomName: room.name,
          visibility: room.visibility
        }
      });
      this.recordPlayerEvent("player_joined", room, player);
      this.emitDirectoryDelta([room], []);
      return response;
    } finally {
      releaseCommand();
    }
  }
  async joinRoom(roomCode, name, password, socketId, profile, rivalry, commandId) {
    await this.removeExpiredRooms();
    const room = this.rooms.get(roomCode);
    const commandKey = this.commandKey(
      "room:join",
      commandId ?? randomUUID3(),
      profile?.id ?? socketId
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey);
      }
      if (this.socketIndex.has(socketId)) {
        return this.rejectJoin(
          null,
          roomError(
            "ALREADY_IN_ROOM",
            "Leave the current room before joining another one."
          )
        );
      }
      if (!room) {
        return this.rejectJoin(
          null,
          roomError("ROOM_NOT_FOUND", "That room does not exist.")
        );
      }
      if (room.players.O) {
        return this.rejectJoin(
          room,
          roomError("ROOM_FULL", "That room already has two players.")
        );
      }
      if (!room.players.X?.connected) {
        return this.rejectJoin(
          room,
          roomError(
            "ROOM_UNAVAILABLE",
            "The host is reconnecting. Try again in a moment."
          )
        );
      }
      if (profile && room.players.X?.id === profile.id) {
        return this.rejectJoin(
          room,
          roomError(
            "PROFILE_IN_USE",
            "This player profile already occupies the host seat."
          )
        );
      }
      if (room.visibility === "private" && (!password || !room.password || !await this.verifyPassword(password, room.password))) {
        return this.rejectJoin(
          room,
          roomError("INVALID_PASSWORD", "That password is incorrect.")
        );
      }
      if (this.rooms.get(roomCode) !== room) {
        return this.rejectJoin(
          null,
          roomError("ROOM_NOT_FOUND", "That room does not exist.")
        );
      }
      if (this.socketIndex.has(socketId)) {
        return this.rejectJoin(
          room,
          roomError(
            "ALREADY_IN_ROOM",
            "Leave the current room before joining another one."
          )
        );
      }
      if (room.players.O) {
        return this.rejectJoin(
          room,
          roomError("ROOM_FULL", "That room already has two players.")
        );
      }
      if (!room.players.X?.connected) {
        return this.rejectJoin(
          room,
          roomError(
            "ROOM_UNAVAILABLE",
            "The host is reconnecting. Try again in a moment."
          )
        );
      }
      if (profile && room.players.X?.id === profile.id) {
        return this.rejectJoin(
          room,
          roomError(
            "PROFILE_IN_USE",
            "This player profile already occupies the host seat."
          )
        );
      }
      const player = this.createPlayer("O", name, socketId, profile);
      room.players.O = player;
      room.matchId = randomUUID3();
      room.match = createMatchState();
      room.rivalry = rivalry ?? { xWins: 0, oWins: 0, draws: 0 };
      room.readyForNextRound.clear();
      room.revision += 1;
      this.touch(room);
      this.socketIndex.set(socketId, { roomCode, player: "O" });
      const response = this.joinSuccess(room, player);
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.recordPlayerEvent("player_joined", room, player);
      this.record({
        type: "match_started",
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          roundNumber: room.match.roundNumber,
          startingPlayer: room.match.round.startingPlayer,
          players: [
            this.playerHistory(room.players.X),
            this.playerHistory(player)
          ]
        }
      });
      this.emitSnapshot(room);
      this.emitDirectoryDelta([room], []);
      return response;
    } finally {
      releaseCommand();
    }
  }
  async resumeRoom(roomCode, sessionToken, socketId, commandId = randomUUID3()) {
    await this.removeExpiredRooms();
    const commandKey = this.commandKey(
      "room:resume",
      commandId,
      sessionToken
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return this.reconnectCachedJoin(cached, socketId, commandKey);
      }
      const room = this.rooms.get(roomCode);
      if (!room) {
        return {
          ok: false,
          error: roomError("ROOM_NOT_FOUND", "That room is no longer active.")
        };
      }
      const player = this.findPlayerByToken(room, sessionToken);
      if (!player) {
        return {
          ok: false,
          error: roomError(
            "SESSION_INVALID",
            "This browser cannot resume that seat."
          )
        };
      }
      if (player.connected && player.socketId === socketId) {
        const response2 = this.joinSuccess(room, player);
        await this.persistMutation({
          upsert: this.persistedRoom(room),
          receipt: this.commandReceipt(commandKey, response2)
        });
        return response2;
      }
      if (player.socketId) {
        this.socketIndex.delete(player.socketId);
      }
      this.clearPlayerTimer(player);
      player.socketId = socketId;
      player.connected = true;
      player.disconnectExpiresAt = null;
      room.revision += 1;
      this.touch(room);
      this.socketIndex.set(socketId, {
        roomCode,
        player: player.mark
      });
      const response = this.joinSuccess(room, player);
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.recordPlayerEvent("player_reconnected", room, player);
      this.emitSnapshot(room);
      this.emitDirectoryDelta([room], []);
      return response;
    } finally {
      releaseCommand();
    }
  }
  async playMove(payload, socketId) {
    const commandKey = this.commandKey(
      "game:play",
      payload.commandId,
      payload.sessionToken
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return cached;
      }
      const authorized = this.authorize(payload, socketId);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { player, room } = authorized.value;
      const snapshot = this.snapshot(room);
      if (!this.hasTwoConnectedPlayers(room)) {
        return failedCommand(
          roomError(
            "OPPONENT_OFFLINE",
            "Play resumes when both players are connected."
          ),
          snapshot
        );
      }
      if (room.match.round.currentPlayer !== player.mark) {
        return failedCommand(
          roomError("NOT_YOUR_TURN", "Wait for your turn."),
          snapshot
        );
      }
      const match = matchReducer(room.match, {
        type: "play",
        index: payload.index
      });
      if (match === room.match) {
        return failedCommand(
          roomError("INVALID_MOVE", "That square is not available."),
          snapshot
        );
      }
      room.match = match;
      room.readyForNextRound.clear();
      room.revision += 1;
      this.touch(room);
      this.record({
        type: "move_played",
        roomId: room.id,
        matchId: room.matchId,
        payload: {
          index: payload.index,
          mark: player.mark,
          moveNumber: match.round.moveCount,
          playerId: player.id,
          roundNumber: match.roundNumber
        }
      });
      const roundCompleted = snapshot.match.round.status === "playing" && match.round.status !== "playing";
      if (roundCompleted) {
        const outcome = match.round.status === "draw" ? "draw" : match.round.winner ?? "draw";
        this.applyProfileRound(room, outcome);
        this.record({
          type: "round_completed",
          roomId: room.id,
          matchId: room.matchId,
          payload: {
            moveCount: match.round.moveCount,
            outcome,
            profileIds: {
              X: room.players.X?.id ?? null,
              O: room.players.O?.id ?? null
            },
            rivalry: room.rivalry ? {
              xWins: room.rivalry.xWins,
              oWins: room.rivalry.oWins,
              draws: room.rivalry.draws
            } : null,
            roundNumber: match.roundNumber,
            scores: {
              X: match.scores.X,
              O: match.scores.O,
              draws: match.scores.draws
            },
            winningLine: match.round.winningLine ?? []
          }
        });
      }
      const nextSnapshot = this.snapshot(room);
      const response = {
        ok: true,
        snapshot: nextSnapshot
      };
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.onSnapshot(nextSnapshot);
      if (roundCompleted) {
        this.emitDirectoryDelta([room], []);
      }
      return response;
    } finally {
      releaseCommand();
    }
  }
  async readyForNextRound(payload, socketId) {
    const commandKey = this.commandKey(
      "game:ready-next",
      payload.commandId,
      payload.sessionToken
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return cached;
      }
      const authorized = this.authorize(payload, socketId);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { player, room } = authorized.value;
      const snapshot = this.snapshot(room);
      if (!this.hasTwoConnectedPlayers(room)) {
        return failedCommand(
          roomError(
            "OPPONENT_OFFLINE",
            "Both players must reconnect before the next round."
          ),
          snapshot
        );
      }
      if (room.match.round.status === "playing") {
        return failedCommand(
          roomError("ROUND_NOT_COMPLETE", "Finish this round first."),
          snapshot
        );
      }
      room.readyForNextRound.add(player.mark);
      if (room.readyForNextRound.size === 2) {
        room.match = matchReducer(room.match, { type: "next-round" });
        room.readyForNextRound.clear();
        this.record({
          type: "round_started",
          roomId: room.id,
          matchId: room.matchId,
          payload: {
            roundNumber: room.match.roundNumber,
            startingPlayer: room.match.round.startingPlayer
          }
        });
      }
      room.revision += 1;
      this.touch(room);
      const nextSnapshot = this.snapshot(room);
      const response = {
        ok: true,
        snapshot: nextSnapshot
      };
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.onSnapshot(nextSnapshot);
      return response;
    } finally {
      releaseCommand();
    }
  }
  async leaveRoom(payload, socketId) {
    const commandKey = this.commandKey(
      "room:leave",
      payload.commandId,
      payload.sessionToken
    );
    const releaseCommand = await this.acquireCommandLock(commandKey);
    try {
      const cached = await this.cachedCommand(commandKey);
      if (cached) {
        return cached;
      }
      const authorized = this.authorizeWithoutRevision(payload, socketId);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { player, room } = authorized.value;
      this.socketIndex.delete(socketId);
      this.clearPlayerTimer(player);
      this.recordPlayerEvent("player_left", room, player, {
        reason: "left"
      });
      if (player.mark === "X") {
        const response2 = {
          ok: true,
          snapshot: null
        };
        await this.closeRoom(
          room,
          "The room host ended the match.",
          "host_left",
          true,
          this.commandReceipt(commandKey, response2)
        );
        return response2;
      }
      this.endMatch(room, "guest_left");
      delete room.players.O;
      room.match = createMatchState();
      room.rivalry = null;
      room.readyForNextRound.clear();
      room.revision += 1;
      this.touch(room);
      const snapshot = this.snapshot(room);
      const response = { ok: true, snapshot };
      await this.persistMutation({
        upsert: this.persistedRoom(room),
        receipt: this.commandReceipt(commandKey, response)
      });
      this.onSnapshot(snapshot);
      this.emitDirectoryDelta([room], []);
      return response;
    } finally {
      releaseCommand();
    }
  }
  async disconnect(socketId) {
    const indexedPlayer = this.socketIndex.get(socketId);
    if (!indexedPlayer) {
      return;
    }
    this.socketIndex.delete(socketId);
    const room = this.rooms.get(indexedPlayer.roomCode);
    const player = room?.players[indexedPlayer.player];
    if (!room || !player || player.socketId !== socketId) {
      return;
    }
    player.socketId = null;
    player.connected = false;
    player.disconnectExpiresAt = this.now() + this.disconnectGraceMs;
    room.readyForNextRound.delete(player.mark);
    room.revision += 1;
    this.touch(room);
    await this.persistMutation({ upsert: this.persistedRoom(room) });
    this.recordPlayerEvent("player_disconnected", room, player);
    this.emitSnapshot(room);
    this.emitDirectoryDelta([room], []);
    player.disconnectTimer = setTimeout(() => {
      void this.expireDisconnectedPlayer(
        room.code,
        player.mark,
        player.sessionToken
      );
    }, this.disconnectGraceMs);
    player.disconnectTimer.unref?.();
  }
  dispose() {
    void this.close();
  }
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const room of this.rooms.values()) {
      for (const player of Object.values(room.players)) {
        if (player) {
          this.clearPlayerTimer(player);
        }
      }
    }
    await Promise.allSettled([...this.commandLocks.values()]);
    await Promise.allSettled([...this.persistenceQueues.values()]);
    this.rooms.clear();
    this.socketIndex.clear();
    this.currentStatus = "closed";
    await this.roomStore.close();
  }
  commandKey(type, commandId, actor) {
    return createHash2("sha256").update(`${type}\0${commandId}\0${actor}`).digest("hex");
  }
  async acquireCommandLock(key) {
    const previous = this.commandLocks.get(key);
    let resolveCurrent = () => void 0;
    const current = new Promise((resolve2) => {
      resolveCurrent = resolve2;
    });
    this.commandLocks.set(key, current);
    if (previous) {
      await previous;
    }
    return () => {
      resolveCurrent();
      if (this.commandLocks.get(key) === current) {
        this.commandLocks.delete(key);
      }
    };
  }
  async cachedCommand(key) {
    const now = this.now();
    const cached = this.commandReceipts.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        return structuredClone(cached.response);
      }
      this.commandReceipts.delete(key);
    }
    try {
      const stored = await this.roomStore.findReceipt(key, now);
      if (!stored) {
        return null;
      }
      const receipt = {
        key,
        response: stored,
        expiresAt: now + COMMAND_RECEIPT_TTL_MS
      };
      this.commandReceipts.set(key, receipt);
      this.currentStatus = "ready";
      return structuredClone(stored);
    } catch (error) {
      this.currentStatus = "degraded";
      console.error("Room command receipt lookup failed.", error);
      return null;
    }
  }
  commandReceipt(key, response) {
    const receipt = {
      key,
      response: structuredClone(response),
      expiresAt: this.now() + COMMAND_RECEIPT_TTL_MS
    };
    this.commandReceipts.set(key, receipt);
    return receipt;
  }
  async reconnectCachedJoin(cached, socketId, commandKey) {
    if (!cached.ok) {
      return cached;
    }
    const room = this.rooms.get(cached.identity.roomCode);
    const player = room ? this.findPlayerByToken(room, cached.identity.sessionToken) : null;
    if (!room || !player) {
      return {
        ok: false,
        error: roomError(
          "ROOM_NOT_FOUND",
          "That room is no longer active."
        )
      };
    }
    if (player.connected && player.socketId === socketId) {
      return this.joinSuccess(room, player);
    }
    if (player.socketId) {
      this.socketIndex.delete(player.socketId);
    }
    this.clearPlayerTimer(player);
    player.socketId = socketId;
    player.connected = true;
    player.disconnectExpiresAt = null;
    room.revision += 1;
    this.touch(room);
    this.socketIndex.set(socketId, {
      roomCode: room.code,
      player: player.mark
    });
    const response = this.joinSuccess(room, player);
    await this.persistMutation({
      upsert: this.persistedRoom(room),
      receipt: this.commandReceipt(commandKey, response)
    });
    this.recordPlayerEvent("player_reconnected", room, player);
    this.emitSnapshot(room);
    this.emitDirectoryDelta([room], []);
    return response;
  }
  async persistMutation(mutation) {
    const queueKey = mutation.upsert?.id ?? mutation.deleteRoomId ?? `receipt:${mutation.receipt?.key ?? randomUUID3()}`;
    const previous = this.persistenceQueues.get(queueKey);
    const commit = (previous ?? Promise.resolve()).catch(() => void 0).then(() => this.roomStore.commit(mutation));
    this.persistenceQueues.set(queueKey, commit);
    try {
      await commit;
      if (!this.closed) {
        this.currentStatus = "ready";
      }
    } catch (error) {
      this.currentStatus = "degraded";
      console.error("Active room persistence failed.", error);
    } finally {
      if (this.persistenceQueues.get(queueKey) === commit) {
        this.persistenceQueues.delete(queueKey);
      }
    }
  }
  persistedRoom(room) {
    const toPlayer = (player) => ({
      id: player.id,
      mark: player.mark,
      name: player.name,
      profile: structuredClone(player.profile),
      persistentProfile: player.persistentProfile,
      sessionToken: player.sessionToken,
      connected: player.connected,
      disconnectExpiresAt: player.disconnectExpiresAt
    });
    return {
      schemaVersion: ROOM_STATE_SCHEMA_VERSION,
      id: room.id,
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      password: room.password ? {
        saltBase64: room.password.salt.toString("base64"),
        hashBase64: room.password.hash.toString("base64")
      } : null,
      matchId: room.matchId,
      match: {
        round: {
          ...room.match.round,
          board: [...room.match.round.board],
          winningLine: room.match.round.winningLine ? [...room.match.round.winningLine] : null
        },
        roundNumber: room.match.roundNumber,
        scores: { ...room.match.scores }
      },
      rivalry: room.rivalry ? { ...room.rivalry } : null,
      revision: room.revision,
      players: {
        X: toPlayer(room.players.X),
        ...room.players.O ? { O: toPlayer(room.players.O) } : {}
      },
      readyForNextRound: [...room.readyForNextRound],
      lastActivityAt: room.lastActivityAt,
      expiresAt: room.lastActivityAt + this.roomTtlMs
    };
  }
  restoreRoom(stored) {
    const now = this.now();
    const toPlayer = (player) => {
      const disconnectExpiresAt = player.connected ? now + this.disconnectGraceMs : player.disconnectExpiresAt ?? now + this.disconnectGraceMs;
      return {
        id: player.id,
        mark: player.mark,
        name: player.name,
        profile: structuredClone(player.profile),
        persistentProfile: player.persistentProfile,
        sessionToken: player.sessionToken,
        socketId: null,
        connected: false,
        disconnectExpiresAt,
        disconnectTimer: null
      };
    };
    const playerX = toPlayer(stored.players.X);
    if (playerX.disconnectExpiresAt !== null && playerX.disconnectExpiresAt <= now) {
      return null;
    }
    const playerO = stored.players.O ? toPlayer(stored.players.O) : null;
    const guestExpired = playerO?.disconnectExpiresAt !== null && playerO?.disconnectExpiresAt !== void 0 && playerO.disconnectExpiresAt <= now;
    const room = {
      id: stored.id,
      code: stored.code,
      name: stored.name,
      visibility: stored.visibility,
      password: stored.password ? {
        salt: Buffer.from(stored.password.saltBase64, "base64"),
        hash: Buffer.from(stored.password.hashBase64, "base64")
      } : null,
      matchId: guestExpired ? null : stored.matchId,
      match: guestExpired ? createMatchState() : structuredClone(stored.match),
      rivalry: guestExpired ? null : stored.rivalry ? { ...stored.rivalry } : null,
      revision: stored.revision + 1,
      players: {
        X: playerX,
        ...!guestExpired && playerO ? { O: playerO } : {}
      },
      readyForNextRound: /* @__PURE__ */ new Set(),
      lastActivityAt: stored.lastActivityAt
    };
    return room;
  }
  schedulePlayerExpirations(room) {
    for (const player of Object.values(room.players)) {
      if (!player || player.connected || player.disconnectExpiresAt === null) {
        continue;
      }
      const delay = Math.max(0, player.disconnectExpiresAt - this.now());
      player.disconnectTimer = setTimeout(() => {
        void this.expireDisconnectedPlayer(
          room.code,
          player.mark,
          player.sessionToken
        );
      }, delay);
      player.disconnectTimer.unref?.();
    }
  }
  createPlayer(mark, name, socketId, profile) {
    const playerProfile = profile ?? this.transientProfile(name, mark);
    return {
      id: playerProfile.id,
      mark,
      name: playerProfile.displayName,
      profile: structuredClone(playerProfile),
      persistentProfile: Boolean(profile),
      sessionToken: randomUUID3(),
      socketId,
      connected: true,
      disconnectExpiresAt: null,
      disconnectTimer: null
    };
  }
  transientProfile(displayName, mark) {
    return {
      id: randomUUID3(),
      displayName,
      avatarKey: mark === "X" ? "coral" : "teal",
      record: {
        wins: 0,
        losses: 0,
        draws: 0
      },
      createdAt: new Date(this.now()).toISOString()
    };
  }
  async hashPassword(password) {
    const salt = randomBytes2(16);
    const hash = await scryptAsync(
      password,
      salt,
      PASSWORD_KEY_LENGTH
    );
    return { salt, hash };
  }
  async verifyPassword(password, record) {
    const candidate = await scryptAsync(
      password,
      record.salt,
      PASSWORD_KEY_LENGTH
    );
    return candidate.length === record.hash.length && timingSafeEqual2(candidate, record.hash);
  }
  createRoomCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error("Unable to allocate a unique room code");
  }
  authorize(payload, socketId) {
    const authorized = this.authorizeWithoutRevision(payload, socketId);
    if (!authorized.ok) {
      return authorized;
    }
    if (authorized.value.room.revision !== payload.revision) {
      return {
        ok: false,
        response: failedCommand(
          roomError(
            "STALE_STATE",
            "The room changed before that action arrived."
          ),
          this.snapshot(authorized.value.room)
        )
      };
    }
    return authorized;
  }
  authorizeWithoutRevision(payload, socketId) {
    const room = this.rooms.get(payload.roomCode);
    if (!room) {
      return {
        ok: false,
        response: failedCommand(
          roomError("ROOM_NOT_FOUND", "That room is no longer active.")
        )
      };
    }
    const player = this.findPlayerByToken(room, payload.sessionToken);
    if (!player || !player.connected || player.socketId !== socketId) {
      return {
        ok: false,
        response: failedCommand(
          roomError("SESSION_INVALID", "Your room session is no longer valid."),
          this.snapshot(room)
        )
      };
    }
    return { ok: true, value: { room, player } };
  }
  findPlayerByToken(room, sessionToken) {
    return Object.values(room.players).find(
      (player) => player?.sessionToken === sessionToken
    ) ?? null;
  }
  hasTwoConnectedPlayers(room) {
    return Boolean(room.players.X?.connected && room.players.O?.connected);
  }
  joinSuccess(room, player) {
    const identity = {
      roomCode: room.code,
      sessionToken: player.sessionToken,
      player: player.mark,
      name: player.name,
      profileId: player.id
    };
    return {
      ok: true,
      identity,
      snapshot: this.snapshot(room)
    };
  }
  snapshot(room) {
    const toSnapshot = (player) => player ? {
      mark: player.mark,
      name: player.name,
      connected: player.connected,
      profile: structuredClone(player.profile)
    } : null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomCode: room.code,
      roomName: room.name,
      visibility: room.visibility,
      revision: room.revision,
      match: room.match,
      players: {
        X: toSnapshot(room.players.X),
        O: toSnapshot(room.players.O)
      },
      rivalry: room.rivalry ? { ...room.rivalry } : null,
      readyForNextRound: [...room.readyForNextRound]
    };
  }
  emitSnapshot(room) {
    const snapshot = this.snapshot(room);
    this.onSnapshot(snapshot);
    return snapshot;
  }
  emitDirectoryDelta(rooms, removedRoomCodes) {
    const uniqueRooms = new Map(
      rooms.filter((room) => this.rooms.get(room.code) === room).map((room) => [room.code, room])
    );
    const removed = [...new Set(removedRoomCodes)].filter(
      (roomCode) => !uniqueRooms.has(roomCode)
    );
    if (uniqueRooms.size === 0 && removed.length === 0) {
      return;
    }
    this.directoryRevision += 1;
    this.onDirectoryDelta({
      revision: this.directoryRevision,
      upserts: [...uniqueRooms.values()].map((room) => this.directoryEntry(room)).sort(
        (first, second) => first.roomName.localeCompare(second.roomName) || first.roomCode.localeCompare(second.roomCode)
      ),
      removedRoomCodes: removed.sort()
    });
  }
  touch(room) {
    room.lastActivityAt = this.now();
  }
  async expireDisconnectedPlayer(roomCode, mark, sessionToken) {
    const room = this.rooms.get(roomCode);
    const player = room?.players[mark];
    if (!room || !player || player.connected || player.sessionToken !== sessionToken) {
      return;
    }
    this.clearPlayerTimer(player);
    if (mark === "X") {
      this.recordPlayerEvent("player_left", room, player, {
        reason: "disconnect_timeout"
      });
      await this.closeRoom(
        room,
        "The room expired after the host disconnected.",
        "host_disconnect_timeout"
      );
      return;
    }
    this.recordPlayerEvent("player_left", room, player, {
      reason: "disconnect_timeout"
    });
    this.endMatch(room, "guest_disconnect_timeout");
    delete room.players.O;
    room.match = createMatchState();
    room.rivalry = null;
    room.readyForNextRound.clear();
    room.revision += 1;
    this.touch(room);
    await this.persistMutation({ upsert: this.persistedRoom(room) });
    this.emitSnapshot(room);
    this.emitDirectoryDelta([room], []);
  }
  async closeRoom(room, reason, historyReason, emitDirectory = true, receipt) {
    this.endMatch(room, historyReason);
    for (const player of Object.values(room.players)) {
      if (player) {
        this.clearPlayerTimer(player);
        if (player.socketId) {
          this.socketIndex.delete(player.socketId);
        }
      }
    }
    this.rooms.delete(room.code);
    await this.persistMutation({
      deleteRoomId: room.id,
      ...receipt ? { receipt } : {}
    });
    this.record({
      type: "room_closed",
      roomId: room.id,
      payload: { reason: historyReason }
    });
    this.onRoomClosed(room.code, reason);
    if (emitDirectory) {
      this.emitDirectoryDelta([], [room.code]);
    }
  }
  clearPlayerTimer(player) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  }
  async removeExpiredRooms() {
    const cutoff = this.now() - this.roomTtlMs;
    const removedRoomCodes = [];
    for (const room of [...this.rooms.values()]) {
      if (room.lastActivityAt < cutoff) {
        await this.closeRoom(
          room,
          "The room expired after a period of inactivity.",
          "room_inactive",
          false
        );
        removedRoomCodes.push(room.code);
      }
    }
    this.emitDirectoryDelta([], removedRoomCodes);
  }
  rejectJoin(room, error) {
    this.record({
      type: "join_rejected",
      roomId: room?.id,
      matchId: room?.matchId,
      payload: { reason: error.code }
    });
    return { ok: false, error };
  }
  playerHistory(player) {
    return player ? {
      id: player.id,
      mark: player.mark,
      name: player.name
    } : null;
  }
  recordPlayerEvent(type, room, player, extra = {}) {
    this.record({
      type,
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        ...this.playerHistory(player),
        ...extra
      }
    });
  }
  applyProfileRound(room, outcome) {
    const playerX = room.players.X;
    const playerO = room.players.O;
    if (!playerX || !playerO) {
      return;
    }
    if (outcome === "draw") {
      playerX.profile = this.incrementProfileRecord(playerX.profile, "draws");
      playerO.profile = this.incrementProfileRecord(playerO.profile, "draws");
    } else {
      const winner = outcome === "X" ? playerX : playerO;
      const loser = outcome === "X" ? playerO : playerX;
      winner.profile = this.incrementProfileRecord(winner.profile, "wins");
      loser.profile = this.incrementProfileRecord(loser.profile, "losses");
    }
    const rivalry = room.rivalry ?? {
      xWins: 0,
      oWins: 0,
      draws: 0
    };
    room.rivalry = {
      xWins: rivalry.xWins + (outcome === "X" ? 1 : 0),
      oWins: rivalry.oWins + (outcome === "O" ? 1 : 0),
      draws: rivalry.draws + (outcome === "draw" ? 1 : 0)
    };
    if (playerX.persistentProfile && playerO.persistentProfile) {
      this.onProfileRoundCompleted({
        xProfileId: playerX.id,
        oProfileId: playerO.id,
        outcome
      });
    }
  }
  incrementProfileRecord(profile, field) {
    return {
      ...profile,
      record: {
        ...profile.record,
        [field]: profile.record[field] + 1
      }
    };
  }
  endMatch(room, reason) {
    if (!room.matchId) {
      return;
    }
    this.record({
      type: "match_ended",
      roomId: room.id,
      matchId: room.matchId,
      payload: {
        moveCount: room.match.round.moveCount,
        reason,
        roundNumber: room.match.roundNumber,
        roundStatus: room.match.round.status,
        scores: {
          X: room.match.scores.X,
          O: room.match.scores.O,
          draws: room.match.scores.draws
        }
      }
    });
    room.matchId = null;
  }
  record(event) {
    this.onHistoryEvent(event);
  }
};

// server/rooms/postgres-store.ts
import { Pool as Pool3 } from "pg";
var RECEIPT_CLEANUP_INTERVAL_MS = 5 * 6e4;
var PostgresRoomStateStore = class {
  backend = "postgres";
  pool;
  nextReceiptCleanupAt = 0;
  constructor(options) {
    const poolConfig = {
      connectionString: options.connectionString,
      application_name: "tic-tac-toe-room-state",
      max: 3
    };
    if (options.requireSsl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
    this.pool = new Pool3(poolConfig);
  }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS active_game_rooms (
        room_id UUID PRIMARY KEY,
        room_code CHAR(6) NOT NULL UNIQUE,
        state JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS active_game_rooms_expires_at_idx
        ON active_game_rooms (expires_at);

      CREATE TABLE IF NOT EXISTS game_command_receipts (
        command_key CHAR(64) PRIMARY KEY,
        response JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS game_command_receipts_expires_at_idx
        ON game_command_receipts (expires_at);

      DELETE FROM active_game_rooms WHERE expires_at <= NOW();
      DELETE FROM game_command_receipts WHERE expires_at <= NOW();
    `);
  }
  async loadActiveRooms(now) {
    const result = await this.pool.query(
      `
        SELECT state
        FROM active_game_rooms
        WHERE expires_at > $1
        ORDER BY updated_at ASC
      `,
      [new Date(now).toISOString()]
    );
    const rooms = [];
    for (const row of result.rows) {
      const parsed = persistedRoomSchema.safeParse(row.state);
      if (parsed.success) {
        rooms.push(parsed.data);
      } else {
        console.error(
          "Stored room state failed validation and was skipped.",
          parsed.error
        );
      }
    }
    return rooms;
  }
  async findReceipt(key, now) {
    if (now >= this.nextReceiptCleanupAt) {
      this.nextReceiptCleanupAt = now + RECEIPT_CLEANUP_INTERVAL_MS;
      await this.pool.query(
        "DELETE FROM game_command_receipts WHERE expires_at <= $1",
        [new Date(now).toISOString()]
      );
    }
    const result = await this.pool.query(
      `
        SELECT response
        FROM game_command_receipts
        WHERE command_key = $1
          AND expires_at > $2
      `,
      [key, new Date(now).toISOString()]
    );
    return result.rows[0]?.response ?? null;
  }
  async commit(mutation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (mutation.deleteRoomId) {
        await client.query(
          "DELETE FROM active_game_rooms WHERE room_id = $1",
          [mutation.deleteRoomId]
        );
      }
      if (mutation.upsert) {
        await client.query(
          `
            INSERT INTO active_game_rooms (
              room_id,
              room_code,
              state,
              expires_at
            )
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (room_id)
            DO UPDATE SET
              room_code = EXCLUDED.room_code,
              state = EXCLUDED.state,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
          `,
          [
            mutation.upsert.id,
            mutation.upsert.code,
            JSON.stringify(mutation.upsert),
            new Date(mutation.upsert.expiresAt).toISOString()
          ]
        );
      }
      if (mutation.receipt) {
        await client.query(
          `
            INSERT INTO game_command_receipts (
              command_key,
              response,
              expires_at
            )
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (command_key)
            DO UPDATE SET
              response = EXCLUDED.response,
              expires_at = EXCLUDED.expires_at
          `,
          [
            mutation.receipt.key,
            JSON.stringify(mutation.receipt.response),
            new Date(mutation.receipt.expiresAt).toISOString()
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
};

// server/rooms/create-room-store.ts
function createRoomStateStore(environment = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    return new InMemoryRoomStateStore();
  }
  return new PostgresRoomStateStore({
    connectionString: databaseUrl,
    requireSsl: environment.DATABASE_SSL === "require"
  });
}

// server/game-server.ts
var RATE_LIMIT_WINDOW_MS = 1e4;
var RATE_LIMIT_MAX_COMMANDS = 40;
var PROFILE_CREATION_RATE_LIMIT_WINDOW_MS = 10 * 6e4;
var PROFILE_CREATION_RATE_LIMIT_MAX_REQUESTS = 10;
var PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS = 1e4;
function invalidRequest(message) {
  return {
    code: "INVALID_REQUEST",
    message
  };
}
function firstValidationMessage(result, fallback) {
  return result.error.issues[0]?.message ?? fallback;
}
function isOriginAllowed(origin, requestHost, allowedOrigins) {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.includes(origin)) {
    return true;
  }
  try {
    const parsedOrigin = new URL(origin);
    if (requestHost && parsedOrigin.host === requestHost) {
      return true;
    }
    if (process.env.NODE_ENV !== "production" && (parsedOrigin.hostname === "127.0.0.1" || parsedOrigin.hostname === "localhost")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
function parseBoundedInteger(value, fallback, maximum) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= maximum ? parsed : fallback;
}
function getAdminCredential(request) {
  const directKey = request.get("x-admin-api-key");
  if (directKey) {
    return directKey;
  }
  const authorization = request.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}
function credentialsMatch(provided, expected) {
  if (!provided) {
    return false;
  }
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual3(providedBytes, expectedBytes);
}
function parseTrustProxy(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}
function createGameServer(options = {}) {
  const app = express();
  const trustProxy = options.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== void 0) {
    app.set("trust proxy", trustProxy);
  }
  const httpServer = createHttpServer(app);
  const configuredOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const io = new Server(httpServer, {
    allowRequest: (request, callback) => {
      callback(
        null,
        isOriginAllowed(
          request.headers.origin,
          request.headers.host,
          configuredOrigins
        )
      );
    },
    cors: {
      origin: true
    },
    maxHttpBufferSize: 1e4,
    serveClient: false
  });
  const history = new HistoryRecorder(
    options.historyStore ?? createHistoryStore(),
    deploymentIdentity()
  );
  const profiles = new ProfileService(
    options.profileStore ?? createProfileStore(),
    {
      onHistoryEvent: (event) => history.record(event)
    }
  );
  const adminApiKey = options.adminApiKey ?? process.env.ADMIN_API_KEY;
  const roomManager = new RoomManager({
    disconnectGraceMs: options.disconnectGraceMs,
    roomTtlMs: options.roomTtlMs,
    roomStore: options.roomStore ?? createRoomStateStore(),
    onSnapshot: (snapshot) => {
      io.to(snapshot.roomCode).emit("room:snapshot", snapshot);
    },
    onDirectoryDelta: (delta) => {
      io.emit("rooms:delta", delta);
    },
    onHistoryEvent: (event) => {
      history.record(event);
    },
    onProfileRoundCompleted: (round) => {
      void profiles.recordRound(
        round.xProfileId,
        round.oProfileId,
        round.outcome
      ).catch((error) => {
        console.error("Player profile score update failed.", error);
      });
    },
    onRoomClosed: (roomCode, reason) => {
      const roomSockets = io.sockets.adapter.rooms.get(roomCode);
      if (roomSockets) {
        for (const socketId of roomSockets) {
          const roomSocket = io.sockets.sockets.get(socketId);
          if (roomSocket) {
            delete roomSocket.data.roomCode;
            delete roomSocket.data.player;
          }
        }
      }
      io.to(roomCode).emit("room:closed", { roomCode, reason });
      io.in(roomCode).socketsLeave(roomCode);
    }
  });
  const rateLimits = /* @__PURE__ */ new Map();
  const profileCreationRateLimits = /* @__PURE__ */ new Map();
  const profileCreationRateLimit = options.profileCreationRateLimit ?? {
    maxRequests: parseBoundedInteger(
      process.env.PROFILE_CREATION_RATE_LIMIT_MAX,
      PROFILE_CREATION_RATE_LIMIT_MAX_REQUESTS,
      1e4
    ),
    windowMs: parseBoundedInteger(
      process.env.PROFILE_CREATION_RATE_LIMIT_WINDOW_MS,
      PROFILE_CREATION_RATE_LIMIT_WINDOW_MS,
      24 * 60 * 6e4
    )
  };
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === "production" ? void 0 : false
    })
  );
  app.use(express.json({ limit: "10kb" }));
  app.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      rooms: roomManager.roomCount,
      uptimeSeconds: Math.floor(process.uptime()),
      history: {
        backend: history.backend,
        status: history.status
      },
      profiles: {
        backend: profiles.backend,
        status: profiles.status
      },
      roomState: {
        backend: roomManager.backend,
        status: roomManager.status
      }
    });
  });
  app.post("/api/profiles/session", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const parsed = profileSessionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        code: "INVALID_REQUEST",
        error: firstValidationMessage(
          parsed,
          "Enter valid player profile details."
        )
      });
      return;
    }
    if (!parsed.data.credentials) {
      const now = Date.now();
      const clientKey = request.ip ?? request.socket.remoteAddress ?? "unknown";
      let state = profileCreationRateLimits.get(clientKey);
      if (state && now - state.windowStartedAt >= profileCreationRateLimit.windowMs) {
        profileCreationRateLimits.delete(clientKey);
        state = void 0;
      }
      if (!state) {
        if (profileCreationRateLimits.size >= PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS) {
          for (const [key, candidate] of profileCreationRateLimits) {
            if (now - candidate.windowStartedAt >= profileCreationRateLimit.windowMs) {
              profileCreationRateLimits.delete(key);
            }
          }
        }
        if (profileCreationRateLimits.size >= PROFILE_CREATION_RATE_LIMIT_MAX_CLIENTS) {
          response.setHeader(
            "Retry-After",
            Math.ceil(profileCreationRateLimit.windowMs / 1e3)
          );
          response.status(429).json({
            ok: false,
            code: "RATE_LIMITED",
            error: "Profile creation is busy. Try again later."
          });
          return;
        }
        state = {
          count: 0,
          windowStartedAt: now
        };
        profileCreationRateLimits.set(clientKey, state);
      }
      if (state.count >= profileCreationRateLimit.maxRequests) {
        const retryAfterMs = profileCreationRateLimit.windowMs - (now - state.windowStartedAt);
        response.setHeader(
          "Retry-After",
          Math.max(1, Math.ceil(retryAfterMs / 1e3))
        );
        response.status(429).json({
          ok: false,
          code: "RATE_LIMITED",
          error: "You reached the profile creation limit. Try again later."
        });
        return;
      }
      state.count += 1;
    }
    try {
      response.status(200).json({
        ok: true,
        session: await profiles.ensureSession(parsed.data)
      });
    } catch (error) {
      if (error instanceof InvalidProfileError) {
        response.status(401).json({
          ok: false,
          code: "INVALID_PROFILE",
          error: error.message
        });
        return;
      }
      console.error("Player profile request failed.", error);
      response.status(503).json({
        ok: false,
        code: "UNAVAILABLE",
        error: "Player profiles are unavailable."
      });
    }
  });
  function authorizeAdmin(request, response) {
    response.setHeader("Cache-Control", "no-store");
    if (!adminApiKey) {
      response.status(503).json({
        error: "History administration is not configured."
      });
      return false;
    }
    if (!credentialsMatch(getAdminCredential(request), adminApiKey)) {
      response.status(401).json({ error: "Invalid operator key." });
      return false;
    }
    return true;
  }
  app.get("/api/admin/history/summary", async (request, response) => {
    if (!authorizeAdmin(request, response)) {
      return;
    }
    const hours = parseBoundedInteger(request.query.hours, 24, 24 * 366);
    try {
      response.status(200).json(await history.getSummary(hours));
    } catch (error) {
      console.error("History summary query failed.", error);
      response.status(503).json({
        error: "History is unavailable."
      });
    }
  });
  app.get("/api/admin/history/events", async (request, response) => {
    if (!authorizeAdmin(request, response)) {
      return;
    }
    const hours = parseBoundedInteger(request.query.hours, 24, 24 * 366);
    const limit = parseBoundedInteger(request.query.limit, 50, 200);
    const beforeValue = request.query.before;
    const before = typeof beforeValue === "string" ? new Date(beforeValue) : void 0;
    if (before && Number.isNaN(before.getTime())) {
      response.status(400).json({ error: "Invalid history cursor." });
      return;
    }
    try {
      response.status(200).json(
        await history.getEvents(hours, limit, before)
      );
    } catch (error) {
      console.error("History event query failed.", error);
      response.status(503).json({
        error: "History is unavailable."
      });
    }
  });
  const staticDirectory = resolve(options.staticDirectory ?? "dist");
  const indexFile = resolve(staticDirectory, "index.html");
  if (existsSync(indexFile)) {
    app.use(express.static(staticDirectory, { index: false }));
    app.use((request, response, next) => {
      if (request.method === "GET" && request.accepts("html") && !request.path.startsWith("/socket.io")) {
        response.sendFile(indexFile);
        return;
      }
      next();
    });
  }
  function consumeRateLimit(socketId) {
    const now = Date.now();
    const state = rateLimits.get(socketId);
    if (!state || now - state.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimits.set(socketId, {
        count: 1,
        windowStartedAt: now
      });
      return true;
    }
    state.count += 1;
    return state.count <= RATE_LIMIT_MAX_COMMANDS;
  }
  function rateLimitResponse() {
    return {
      ok: false,
      error: rateLimitError()
    };
  }
  function rateLimitError() {
    return {
      code: "RATE_LIMITED",
      message: "Too many actions arrived at once. Wait a moment."
    };
  }
  function rateLimitJoinResponse() {
    return {
      ok: false,
      error: rateLimitError()
    };
  }
  async function resolveSocketProfile(credentials) {
    if (!credentials) {
      return { ok: true };
    }
    try {
      return {
        ok: true,
        profile: await profiles.authenticate(credentials)
      };
    } catch (error) {
      if (error instanceof InvalidProfileError) {
        return {
          ok: false,
          error: {
            code: "PROFILE_INVALID",
            message: "Refresh your player profile and try again."
          }
        };
      }
      console.error("Player profile authentication failed.", error);
      return {
        ok: false,
        error: {
          code: "ROOM_UNAVAILABLE",
          message: "Player profiles are unavailable."
        }
      };
    }
  }
  io.on("connection", (socket) => {
    socket.on("rooms:list", async (ack) => {
      ack(await roomManager.getDirectory());
    });
    socket.on("room:create", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse());
        return;
      }
      if (socket.data.roomCode) {
        ack({
          ok: false,
          error: {
            code: "ALREADY_IN_ROOM",
            message: "Leave the current room before creating another one."
          }
        });
        return;
      }
      const parsed = createRoomPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest(
            firstValidationMessage(parsed, "Enter a valid display name.")
          )
        });
        return;
      }
      const profileResult = await resolveSocketProfile(parsed.data.profile);
      if (!profileResult.ok) {
        ack({ ok: false, error: profileResult.error });
        return;
      }
      const response = await roomManager.createRoom(
        {
          commandId: parsed.data.commandId,
          name: parsed.data.name,
          roomName: parsed.data.roomName,
          visibility: parsed.data.visibility,
          password: parsed.data.password,
          profile: profileResult.profile
        },
        socket.id
      );
      if (response.ok) {
        if (socket.connected) {
          socket.join(response.identity.roomCode);
          socket.data.roomCode = response.identity.roomCode;
          socket.data.player = response.identity.player;
        } else {
          await roomManager.disconnect(socket.id);
        }
      }
      ack(response);
    });
    socket.on("room:join", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse());
        return;
      }
      if (socket.data.roomCode) {
        ack({
          ok: false,
          error: {
            code: "ALREADY_IN_ROOM",
            message: "Leave the current room before joining another one."
          }
        });
        return;
      }
      const parsed = joinRoomPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest(
            firstValidationMessage(parsed, "Enter valid room details.")
          )
        });
        return;
      }
      const profileResult = await resolveSocketProfile(parsed.data.profile);
      if (!profileResult.ok) {
        ack({ ok: false, error: profileResult.error });
        return;
      }
      let rivalry;
      const hostProfileId = roomManager.getHostProfileId(
        parsed.data.roomCode
      );
      if (profileResult.profile && hostProfileId && hostProfileId !== profileResult.profile.id) {
        try {
          rivalry = await profiles.getRivalry(
            hostProfileId,
            profileResult.profile.id
          );
        } catch (error) {
          console.error("Player rivalry lookup failed.", error);
          ack({
            ok: false,
            error: {
              code: "ROOM_UNAVAILABLE",
              message: "Player profiles are unavailable."
            }
          });
          return;
        }
      }
      const response = await roomManager.joinRoom(
        parsed.data.roomCode,
        parsed.data.name,
        parsed.data.password,
        socket.id,
        profileResult.profile,
        rivalry,
        parsed.data.commandId
      );
      if (response.ok) {
        if (socket.connected) {
          socket.join(response.identity.roomCode);
          socket.data.roomCode = response.identity.roomCode;
          socket.data.player = response.identity.player;
        } else {
          await roomManager.disconnect(socket.id);
        }
      }
      ack(response);
    });
    socket.on("room:resume", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitJoinResponse());
        return;
      }
      const parsed = roomSessionPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest("The saved room session is invalid.")
        });
        return;
      }
      const response = await roomManager.resumeRoom(
        parsed.data.roomCode,
        parsed.data.sessionToken,
        socket.id,
        parsed.data.commandId
      );
      if (response.ok) {
        socket.join(response.identity.roomCode);
        socket.data.roomCode = response.identity.roomCode;
        socket.data.player = response.identity.player;
      }
      ack(response);
    });
    socket.on("game:play", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse());
        return;
      }
      const parsed = playMovePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest("That move request is invalid.")
        });
        return;
      }
      ack(await roomManager.playMove(parsed.data, socket.id));
    });
    socket.on("game:ready-next", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse());
        return;
      }
      const parsed = roomCommandPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest("That next-round request is invalid.")
        });
        return;
      }
      ack(await roomManager.readyForNextRound(parsed.data, socket.id));
    });
    socket.on("room:leave", async (payload, ack) => {
      if (!consumeRateLimit(socket.id)) {
        ack(rateLimitResponse());
        return;
      }
      const parsed = leaveRoomPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack({
          ok: false,
          error: invalidRequest("That leave request is invalid.")
        });
        return;
      }
      const roomCode = parsed.data.roomCode;
      const response = await roomManager.leaveRoom(parsed.data, socket.id);
      if (response.ok) {
        socket.leave(roomCode);
        delete socket.data.roomCode;
        delete socket.data.player;
      }
      ack(response);
    });
    socket.on("disconnect", () => {
      rateLimits.delete(socket.id);
      void roomManager.disconnect(socket.id);
    });
  });
  async function listen(port2, host2 = "0.0.0.0") {
    await history.initialize();
    try {
      await profiles.initialize();
      await roomManager.initialize();
    } catch (error) {
      await Promise.allSettled([
        roomManager.close(),
        profiles.close(),
        history.close()
      ]);
      throw error;
    }
    const address2 = await new Promise((resolvePromise, reject) => {
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const serverAddress = httpServer.address();
        if (!serverAddress || typeof serverAddress === "string") {
          reject(new Error("The game server did not expose a TCP address."));
          return;
        }
        resolvePromise({
          host: host2,
          port: serverAddress.port
        });
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port2, host2);
    });
    history.record({
      type: "service_started",
      payload: {
        environment: process.env.NODE_ENV ?? "development",
        historyBackend: history.backend,
        profileBackend: profiles.backend,
        roomStateBackend: roomManager.backend
      }
    });
    await history.flush();
    return address2;
  }
  let closePromise = null;
  function close() {
    closePromise ??= (async () => {
      history.record({
        type: "service_stopped",
        payload: {
          uptimeSeconds: Math.floor(process.uptime())
        }
      });
      await roomManager.close();
      await new Promise((resolvePromise) => {
        io.close(() => {
          resolvePromise();
        });
      });
      await Promise.all([profiles.close(), history.close()]);
    })();
    return closePromise;
  }
  return {
    app,
    io,
    roomManager,
    history,
    profiles,
    listen,
    close
  };
}

// server/index.ts
var parsedPort = Number.parseInt(process.env.PORT ?? "3001", 10);
var port = Number.isFinite(parsedPort) ? parsedPort : 3001;
var host = process.env.HOST ?? "0.0.0.0";
var server = createGameServer();
var address = await server.listen(port, host);
console.log(`Tic Tac Toe server listening on ${address.host}:${address.port}`);
async function shutDown() {
  await server.close();
  process.exit(0);
}
process.once("SIGINT", () => {
  void shutDown();
});
process.once("SIGTERM", () => {
  void shutDown();
});
//# sourceMappingURL=index.js.map