import { Client } from 'ssh2';

/**
 * The one place the server talks SSH (docs/design/cloud-workstations-and-forges.md part 1, decision C2). Credentials are
 * passed in for one session and dropped when it closes; nothing here persists them. Tests replace the connector.
 */
export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** `SHA256:...`; when set, a server presenting another key is refused. */
  expectedFingerprint?: string;
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshSession {
  /** `SHA256:...` of the host key the server presented. */
  fingerprint: string;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<SshResult>;
  close(): void;
}

export interface SshConnector {
  connect(opts: SshConnectOptions): Promise<SshSession>;
}

export class SshError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'auth' | 'host_key' | 'timeout' | 'other',
    message: string,
  ) {
    super(message);
  }
}

const MAX_OUTPUT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;

/** `SHA256:<base64 without padding>` from the hex digest ssh2 hands the verifier. */
const fingerprintOf = (hexSha256: string): string =>
  `SHA256:${Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '')}`;

export const realSshConnector: SshConnector = {
  connect(o) {
    return new Promise<SshSession>((resolve, reject) => {
      const client = new Client();
      let fingerprint = '';
      let settled = false;
      const fail = (e: SshError) => {
        if (settled) return;
        settled = true;
        client.end();
        reject(e);
      };
      client
        .on('ready', () => {
          if (settled) return;
          settled = true;
          resolve({
            fingerprint,
            exec: (command, opts) =>
              new Promise<SshResult>((res, rej) => {
                const timer = setTimeout(
                  () => rej(new SshError('timeout', 'the command took too long')),
                  opts?.timeoutMs ?? 20 * 60_000,
                );
                client.exec(command, (err, stream) => {
                  if (err) {
                    clearTimeout(timer);
                    return rej(new SshError('other', err.message));
                  }
                  let stdout = '';
                  let stderr = '';
                  stream.on('data', (d: Buffer) => {
                    stdout = (stdout + d.toString('utf8')).slice(-MAX_OUTPUT);
                  });
                  stream.stderr.on('data', (d: Buffer) => {
                    stderr = (stderr + d.toString('utf8')).slice(-MAX_OUTPUT);
                  });
                  stream.on('close', (code: number | null) => {
                    clearTimeout(timer);
                    res({ code: code ?? -1, stdout, stderr });
                  });
                });
              }),
            close: () => client.end(),
          });
        })
        .on('error', (err: Error & { level?: string }) => {
          if (err.level === 'client-authentication')
            fail(new SshError('auth', 'the server refused the login'));
          else if (err.level === 'client-timeout' || /ETIMEDOUT|timed out/i.test(err.message))
            fail(new SshError('timeout', 'the server did not answer in time'));
          else if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(err.message))
            fail(new SshError('unreachable', 'could not reach the server (check the host name and port)'));
          else fail(new SshError('other', err.message));
        })
        .connect({
          host: o.host,
          port: o.port,
          username: o.username,
          password: o.password,
          privateKey: o.privateKey,
          passphrase: o.passphrase,
          readyTimeout: CONNECT_TIMEOUT_MS,
          hostHash: 'sha256',
          hostVerifier: (hash: string) => {
            fingerprint = fingerprintOf(hash);
            if (o.expectedFingerprint && o.expectedFingerprint !== fingerprint) {
              fail(
                new SshError(
                  'host_key',
                  `the server's host key (${fingerprint}) is not the one you expected (${o.expectedFingerprint})`,
                ),
              );
              return false;
            }
            return true;
          },
        });
    });
  },
};
