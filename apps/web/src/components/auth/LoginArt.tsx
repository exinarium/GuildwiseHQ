import art from '../../assets/login-art.svg?raw';

// Mark the lit lime nodes so CSS can pulse them; the markup is our own static asset.
const markup = art
  .replace(
    /<circle ([^>]*?)r="14" fill="#D4F24A"\/>/,
    '<circle $1r="14" fill="#D4F24A"/><circle $1r="14" fill="#D4F24A" class="core" fill-opacity="0.35"/>',
  )
  .replace(/(<circle (?:(?!r="14")[^>])*fill="#D4F24A")\/>/g, '$1 class="lit"/>');

/** The constellation behind the brand panel. Decorative. */
export function LoginArt({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={`login-art ${className ?? ''}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a bundled static SVG, never user content
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
