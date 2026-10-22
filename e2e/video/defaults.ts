import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Imported first by the video config: a stack of its own (port, database, scratch dir) so recording never touches
// the regular e2e stack. Everything can be overridden from the environment. To record several videos at once, give
// every recording its own AOM_VIDEO_PORT and AOM_VIDEO_DB (see docs/guide/README.md, "Recording a video"):
//   AOM_VIDEO_PORT      the server's port (default 4671)
//   AOM_VIDEO_DB        the Postgres database, dropped and created for the run (default aom_onboard_video)
//   AOM_VIDEO_DIR_BASE  the folder that holds the run's scratch dir (default TMPDIR, else the system temp dir)
// The scratch dir is `aom-e2e-video` for the default port and `aom-e2e-video-<port>` for any other, so two runs
// never share one. AOM_E2E_PORT, AOM_E2E_DB and AOM_E2E_DIR still win when set.
process.env.AOM_E2E_PORT ??= process.env.AOM_VIDEO_PORT ?? '4671';
const port = process.env.AOM_E2E_PORT;
process.env.AOM_E2E_DB ??= process.env.AOM_VIDEO_DB ?? 'aom_onboard_video';
process.env.AOM_E2E_DIR ??= join(
  process.env.AOM_VIDEO_DIR_BASE ?? tmpdir(), // under TMPDIR, not /tmp, when it is set
  port === '4671' ? 'aom-e2e-video' : `aom-e2e-video-${port}`,
);
// the mock agent takes a step every couple of seconds: cards are still moving while the voice explains the board
process.env.AOM_MOCK_STEP_MS ??= '2500';
// the demo organization and person: friendly names for the recording
process.env.AOM_E2E_ADMIN_ORG ??= 'Acme';
process.env.AOM_E2E_ADMIN_NAME ??= 'Alex Morgan';
// the mock BA answers the demo question like a real analyst (a recording-only reply map, see the mock adapter)
process.env.AOM_MOCK_CHAT_TOKEN_MS ??= '55';
