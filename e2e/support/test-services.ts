/**
 * The project's "Local test services" declaration, as the runner hands it to a tester shift (AOM_TEST_SERVICES, a list of
 * `host:port`). Every declared port is bridged in every shell of the shift, so a port the suite CONNECTS to must be
 * declared and a port the harness LISTENS on must not be.
 */
export const TEST_SERVICES_SETTING = 'Project settings > Local test services';

export type Declared = { connect: Set<number>; inShift: boolean };

export function declaredServices(env: NodeJS.ProcessEnv = process.env): Declared {
  const connect = new Set<number>();
  const spec = env.AOM_TEST_SERVICES ?? '';
  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const port = Number(entry.slice(entry.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) connect.add(port);
  }
  const inShift = env.AOM_TEST_SERVICES !== undefined || env.AOM_AGENT_TMP_ROOT !== undefined;
  return { connect, inShift };
}

/** A port the suite connects to: in a shift it must be declared. Outside a shift any port is allowed. */
export function requireDeclared(port: number, what: string, env: NodeJS.ProcessEnv = process.env): void {
  const d = declaredServices(env);
  if (d.inShift && !d.connect.has(port)) {
    throw new Error(
      `port ${port} (${what}) is not declared: ask the project Owner to add "${what.replace(/\s+/g, '-')} 127.0.0.1:${port}" in ${TEST_SERVICES_SETTING}`,
    );
  }
}

/** A port the harness listens on: in a shift it must NOT be declared, because every shell would bridge it. */
export function requireBindable(port: number, what: string, env: NodeJS.ProcessEnv = process.env): void {
  const d = declaredServices(env);
  if (d.inShift && d.connect.has(port)) {
    throw new Error(
      `port ${port} (${what}) is declared as a local test service, so every shell of the shift bridges it and the harness cannot listen on it: ask the project Owner to remove it from ${TEST_SERVICES_SETTING}`,
    );
  }
}
