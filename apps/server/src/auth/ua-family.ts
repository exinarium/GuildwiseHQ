/**
 * The browser family plus OS of a user agent, normalized (R4, [rv 11]): `chrome/linux`, `firefox/windows`,
 * `safari/ios`. Never the full user agent and never a version, so a browser update is not a new device. Used for the
 * new-device check, the account-lock exemption (R2 a) and the Security page; at most 80 characters.
 */
export function uaFamily(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 400);
  if (!ua.trim()) return 'unknown';
  return `${browserOf(ua)}/${osOf(ua)}`;
}

function browserOf(ua: string): string {
  // Order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari".
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/\b(OPR|Opera)\//.test(ua)) return 'opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'samsung';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'safari';
  if (/^curl\//i.test(ua)) return 'curl';
  if (/\b(node-fetch|undici|axios|python-requests|Go-http-client|okhttp)\b/i.test(ua)) return 'script';
  if (/lightMyRequest/i.test(ua)) return 'test';
  return 'other';
}

function osOf(ua: string): string {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
  if (/\bAndroid\b/.test(ua)) return 'android';
  if (/\bCrOS\b/.test(ua)) return 'chromeos';
  if (/\bWindows\b/.test(ua)) return 'windows';
  if (/\b(Macintosh|Mac OS X)\b/.test(ua)) return 'macos';
  if (/\b(Linux|X11)\b/.test(ua)) return 'linux';
  return 'other';
}
