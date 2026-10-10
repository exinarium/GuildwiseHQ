// Imported first by the video config: a stack of its own (port, database, scratch dir) so recording never touches
// the regular e2e stack. Everything can be overridden from the environment.
process.env.AOM_E2E_PORT ??= '4671';
process.env.AOM_E2E_DB ??= 'aom_onboard_video';
process.env.AOM_E2E_DIR ??= '/tmp/aom-e2e-video';
// the mock agent takes a step every second or so: slow enough to see a card move, fast enough for a short video
process.env.AOM_MOCK_STEP_MS ??= '1200';
