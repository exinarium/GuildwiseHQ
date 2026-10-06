export const cx = (...c: Array<string | false | undefined | null>): string => c.filter(Boolean).join(' ');
