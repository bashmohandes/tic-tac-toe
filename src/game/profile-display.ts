import type { PublicPlayerProfile } from './protocol'

export function profileRecordLabel(profile: PublicPlayerProfile): string {
  const { wins, losses, draws } = profile.record
  return `${wins}W ${losses}L ${draws}D`
}
