import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default algorithm), OWASP baseline parameters (docs/ARCHITECTURE.md section 18).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verified against when the user does not exist, so failures take the same time.
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => {
  dummy ??= hashPassword('not-a-real-password-for-timing');
  return dummy;
};
