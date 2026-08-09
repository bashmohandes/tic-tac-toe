import { InMemoryRoomStateStore } from './in-memory-store'
import { PostgresRoomStateStore } from './postgres-store'
import type { RoomStateStore } from './store'

export function createRoomStateStore(
  environment: NodeJS.ProcessEnv = process.env,
): RoomStateStore {
  const databaseUrl = environment.DATABASE_URL

  if (!databaseUrl) {
    return new InMemoryRoomStateStore()
  }

  return new PostgresRoomStateStore({
    connectionString: databaseUrl,
    requireSsl: environment.DATABASE_SSL === 'require',
  })
}
