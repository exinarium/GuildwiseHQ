import { localAdoptEnv, sshShipEnv } from '../src/index.ts';

/** The first adopter's two environments (docs/design/deploy-run-ux-design.md sections 2 J8 and 4.3). */
export const FIRST_ADOPTER = () => ({
  environments: [
    localAdoptEnv({
      name: 'uat',
      label: 'Test copy',
      target: 'aom-uat',
      composeFile: '~/.config/aom-uat/docker-compose.yml',
      composeProject: 'aom-uat',
      service: 'app',
      imageName: 'aom-uat-app',
      appUrl: 'http://localhost:4700',
      database: { service: 'postgres', dir: '~/.config/aom-uat/backups' },
    }),
    sshShipEnv(
      {
        name: 'production',
        label: 'Live site',
        target: 'prod-server',
        host: 'prod-server',
        composeFile: '/opt/app/docker-compose.yml',
        service: 'app',
        imageName: 'guildwise-hq',
        imageVar: 'GUILDWISE_IMAGE',
        healthUrl: 'https://hq.example.com/ready',
        database: { service: 'postgres', dir: '/opt/app/backups' },
      },
      'uat',
    ),
  ],
});
