import { test } from '@playwright/test';
import { stopJourneyContainers } from '../support/journey-containers.ts';

test('remove the throwaway containers of the deploy-setup journey', () => {
  stopJourneyContainers();
});
