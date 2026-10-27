import { describe, expect, it } from 'vitest';
import { answersFromEnv, buildEnv, emptyAnswers } from '../components/environments/answers.ts';

const base = () => ({
  ...emptyAnswers('live', 'Shop'),
  name: 'shop',
  hosting: 'this_computer' as const,
  stackPath: '/home/u/shop/docker-compose.yml',
  appService: 'app',
  imageName: 'shop',
  dbService: 'postgres',
});

const dirOf = (env: ReturnType<typeof buildEnv>) => {
  const db = env.steps.find((s) => s.kind === 'db_backup');
  return db && 'dir' in db ? db.dir : undefined;
};

describe('database backup directory default', () => {
  it('new setups default to ~/guildwise-backups', () => {
    expect(dirOf(buildEnv(base()))).toBe('~/guildwise-backups');
  });

  it('an existing environment keeps its stored directory when edited', () => {
    const stored = buildEnv({ ...base(), backupDir: '~/aom-backups' });
    expect(dirOf(stored)).toBe('~/aom-backups');
    const reopened = answersFromEnv(stored, { production: false });
    expect(reopened.backupDir).toBe('~/aom-backups');
    expect(dirOf(buildEnv(reopened))).toBe('~/aom-backups');
  });
});
