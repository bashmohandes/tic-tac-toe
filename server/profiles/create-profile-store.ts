import { InMemoryProfileStore } from './in-memory-store'
import { PostgresProfileStore } from './postgres-store'
import type { ProfileStore } from './store'

export function createProfileStore(
  environment: NodeJS.ProcessEnv = process.env,
): ProfileStore {
  const databaseUrl = environment.DATABASE_URL

  if (!databaseUrl) {
    return new InMemoryProfileStore()
  }

  return new PostgresProfileStore({
    connectionString: databaseUrl,
    requireSsl: environment.DATABASE_SSL === 'require',
  })
}
