/**
 * A one-time key pair the browser makes for a single read of an authored pack (the capability editor opening a pack, "export").
 * The runner seals the files to the public half (`sealLarge`), the server relays the ciphertext and never sees the files, and
 * only this page can open them. The private key lives in memory for the duration of the read.
 */
export interface ReplyKey {
  /** SPKI, base64: what `pack.read` carries as `replyKey`. */
  publicKey: string;
  /** Opens `sealLarge` output (`h1.<wrapped key>.<iv>.<ciphertext+tag>`). */
  open(sealed: string): Promise<string>;
}

const b64 = (u: Uint8Array): string => {
  let bin = '';
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function makeReplyKey(): Promise<ReplyKey> {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return {
    publicKey: b64(spki),
    async open(sealed: string): Promise<string> {
      const [v, wrapped, iv, ct] = sealed.split('.');
      if (v !== 'h1' || !wrapped || !iv || !ct) throw new Error('not a sealed value');
      const raw = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, unb64(wrapped)));
      const aes = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, aes, unb64(ct));
      return new TextDecoder().decode(plain);
    },
  };
}
