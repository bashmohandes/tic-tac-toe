import type { HistoryStore } from './store'
import { InMemoryHistoryStore } from './in-memory-store'
import { PostgresHistoryStore } from './postgres-store'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function createHistoryStore(
  environment: NodeJS.ProcessEnv = process.env,
): HistoryStore {
  const databaseUrl = environment.DATABASE_URL

  if (!databaseUrl) {
    return new InMemoryHistoryStore()
  }

  return new PostgresHistoryStore({
    connectionString: databaseUrl,
    retentionDays: positiveInteger(
      environment.HISTORY_RETENTION_DAYS,
      365,
    ),
    requireSsl: environment.DATABASE_SSL === 'require',
  })
}

export function deploymentIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): {
  readonly instanceId?: string
  readonly releaseId?: string
} {
  const instanceId =
    environment.SERVICE_INSTANCE_ID ??
    environment.RENDER_INSTANCE_ID ??
    environment.FLY_ALLOC_ID ??
    environment.RAILWAY_REPLICA_ID
  const releaseId =
    environment.RELEASE_SHA ??
    environment.RENDER_GIT_COMMIT ??
    environment.FLY_IMAGE_REF ??
    environment.RAILWAY_DEPLOYMENT_ID

  return {
    ...(instanceId ? { instanceId } : {}),
    ...(releaseId ? { releaseId } : {}),
  }
}
