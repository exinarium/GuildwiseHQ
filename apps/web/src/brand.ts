/** The single source of truth for the product's user-facing name. A rename is an edit here plus public/brand/. */
export const BRAND = {
  name: 'Guildwise',
  descriptor: 'Guildwise: your guild of AI agents',
  slogan: 'Many hands. One master.',
  domain: 'guildwisehq.com',
  storagePrefix: 'guildwise', // keys: guildwise-theme, guildwise-sidebar (public/theme-init.js mirrors the theme key)
} as const;

export const pageTitle = (...parts: Array<string | undefined | null | false>): string =>
  [...parts.filter((p): p is string => !!p), BRAND.name].join(' · ');
