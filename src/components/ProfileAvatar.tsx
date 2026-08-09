import type {
  PlayerAvatarKey,
  PublicPlayerProfile,
} from '../game/protocol'

interface ProfileAvatarProps {
  readonly avatarKey?: PlayerAvatarKey
  readonly className?: string
  readonly name: string
  readonly profile?: PublicPlayerProfile
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)

  if (parts.length === 0) {
    return '?'
  }

  const first = [...parts[0]][0] ?? '?'
  const second =
    parts.length > 1 ? ([...parts.at(-1)!][0] ?? '') : ''
  return `${first}${second}`.toUpperCase()
}

export function ProfileAvatar({
  avatarKey,
  className = '',
  name,
  profile,
}: ProfileAvatarProps) {
  const color = profile?.avatarKey ?? avatarKey ?? 'teal'

  return (
    <span
      aria-label={`${name} profile`}
      className={`profile-avatar profile-avatar--${color} ${className}`.trim()}
      title={name}
    >
      {initials(name)}
    </span>
  )
}
