import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Imported first by the video config: a stack of its own (port, database, scratch dir) so recording never touches
// the regular e2e stack. Everything can be overridden from the environment.
process.env.AOM_E2E_PORT ??= '4671';
process.env.AOM_E2E_DB ??= 'aom_onboard_video';
process.env.AOM_E2E_DIR ??= join(tmpdir(), 'aom-e2e-video'); // under TMPDIR, not /tmp, when it is set
// the mock agent takes a step every couple of seconds: cards are still moving while the voice explains the board
process.env.AOM_MOCK_STEP_MS ??= '2500';
// the demo organization and person: friendly names for the recording
process.env.AOM_E2E_ADMIN_ORG ??= 'Acme';
process.env.AOM_E2E_ADMIN_NAME ??= 'Alex Morgan';
// the mock BA answers the demo question like a real analyst (a recording-only reply map, see the mock adapter)
process.env.AOM_MOCK_CHAT_TOKEN_MS ??= '55';
