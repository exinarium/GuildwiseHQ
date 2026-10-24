import { maskText } from '@aom/shared';

/** A notification body: one plain line of at most 140 characters, no code, no secrets, no paths or ids. */
export function safeBody(text: string | null | undefined, max = 140): string {
  const plain = maskText(
    (text ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[#*_>]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
