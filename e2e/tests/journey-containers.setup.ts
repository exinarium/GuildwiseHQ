import { test } from '@playwright/test';
import { startJourneyContainers } from '../support/journey-containers.ts';

test('start the throwaway registry and sshd server of the deploy-setup journey', () => {
  startJourneyContainers();
});
