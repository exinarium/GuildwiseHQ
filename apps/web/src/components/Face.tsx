import { type AvatarStyle, type UserAvatar as UserAvatarValue, userAvatarImageUrl } from '@aom/shared';
import { useAgentFace } from '../lib/agentFaces.ts';
import { hueFor, initials } from '../lib/avatar.ts';
import { useFaceUri } from '../lib/faces.ts';
import { cx } from './ui/cx.ts';
import { Avatar } from './ui.tsx';

/** A generated face in a circle (initials while its style is still loading). */
export function Face({
  seed,
  style = 'notionists',
  name,
  size = 24,
  className,
  label,
}: {
  seed: string;
  style?: AvatarStyle;
  name: string;
  size?: number;
  className?: string;
  /** Accessible name; default "Face of <name>". */
  label?: string;
}) {
  const uri = useFaceUri(seed, style);
  if (!uri) return <Avatar name={name} size={size} />;
  return (
    <span
      role="img"
      aria-label={label ?? `Face of ${name}`}
      title={name}
      data-testid="face"
      data-seed={seed}
      data-style={style}
      style={{ width: size, height: size }}
      className={cx('inline-flex shrink-0 overflow-hidden rounded-full bg-sunken', className)}
    >
      <img src={uri} alt="" width={size} height={size} draggable={false} className="size-full object-cover" />
    </span>
  );
}

/**
 * An agent's face wherever the agent appears. Pass `agentId` when you have it (the roster is looked up by id, then by
 * name); `seed` and `style` skip the lookup (the agent page knows them). Initials until the roster is known.
 */
export function AgentAvatar({
  agentId,
  name,
  size = 24,
  seed,
  style,
  className,
}: {
  agentId?: string | null;
  name: string;
  size?: number;
  seed?: string | undefined;
  style?: AvatarStyle | undefined;
  className?: string;
}) {
  const { face, known } = useAgentFace(agentId, name);
  const s = seed ?? face?.seed ?? (known ? name : undefined);
  if (!s) return <Avatar name={name} size={size} />;
  return (
    <Face
      seed={s}
      style={style ?? face?.style ?? 'notionists'}
      name={name}
      size={size}
      {...(className ? { className } : {})}
    />
  );
}

/** A user's picture: their generated face, their uploaded or photographed image, or initials. */
export function UserAvatar({
  user,
  size = 24,
  className,
}: {
  user: { id?: string | null | undefined; displayName: string; avatar?: UserAvatarValue | null | undefined };
  size?: number;
  className?: string;
}) {
  const a = user.avatar;
  if (a?.kind === 'cartoon')
    return (
      <Face
        seed={a.seed}
        style={a.style}
        name={user.displayName}
        size={size}
        label={`Picture of ${user.displayName}`}
        {...(className ? { className } : {})}
      />
    );
  if (a?.kind === 'image' && user.id)
    return (
      <span
        role="img"
        aria-label={`Picture of ${user.displayName}`}
        title={user.displayName}
        data-testid="user-photo"
        style={{ width: size, height: size }}
        className={cx('inline-flex shrink-0 overflow-hidden rounded-full bg-sunken', className)}
      >
        <img
          src={userAvatarImageUrl(user.id, a.version)}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="size-full object-cover"
        />
      </span>
    );
  return (
    <span
      role="img"
      aria-label={`Avatar for ${user.displayName}`}
      title={user.displayName}
      data-testid="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.42)),
        backgroundColor: `hsl(${hueFor(user.displayName)} 50% 30%)`,
      }}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none"
    >
      {initials(user.displayName)}
    </span>
  );
}
