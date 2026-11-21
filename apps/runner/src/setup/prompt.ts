import { createInterface } from 'node:readline';

/** The questions `setup` asks at the keyboard. Tests script the answers. */
export interface Prompter {
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  choose<T extends string>(question: string, choices: readonly T[], defaultChoice: T): Promise<T>;
  text(question: string, defaultText?: string): Promise<string>;
  /** A secret typed without echo (the current user's sudo password). */
  secret(question: string): Promise<string>;
}

function ask(question: string, mute = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (mute) {
    // biome-ignore lint/suspicious/noExplicitAny: readline's private writer, the usual way to hide typed input
    const r = rl as any;
    r._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
  }
  return new Promise<string>((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      if (mute) process.stdout.write('\n');
      resolve(a);
    }),
  );
}

export const terminalPrompter: Prompter = {
  async confirm(question, defaultYes) {
    const a = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (a === '') return defaultYes;
    return a === 'y' || a === 'yes';
  },
  async choose(question, choices, defaultChoice) {
    for (;;) {
      const a = (await ask(`${question} (${choices.join('/')}, default ${defaultChoice}) `)).trim();
      if (a === '') return defaultChoice;
      const hit = choices.find((c) => c === a);
      if (hit) return hit;
    }
  },
  async text(question, defaultText = '') {
    const a = (await ask(`${question}${defaultText ? ` (default ${defaultText})` : ''} `)).trim();
    return a === '' ? defaultText : a;
  },
  secret: (question) => ask(`${question} `, true),
};
