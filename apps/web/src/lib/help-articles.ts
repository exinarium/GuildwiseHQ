/** The help centre's articles as data (plain language; no jargon without a sentence of explanation). */
export interface HelpEntry {
  q: string;
  a: string;
}
export interface HelpArticle {
  id: string;
  title: string;
  intro: string;
  entries: HelpEntry[];
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'install-troubleshooting',
    title: 'Installing a workstation: if something goes wrong',
    intro:
      'The installer is safe to run again at any time: it carries on where it stopped, repairs what is broken and keeps what works. Start with the step it stopped at (the last line marked with [x]), then look for it below.',
    entries: [
      {
        q: 'It says the link has expired or the pairing code was refused',
        a: 'For safety the command works for 30 minutes and its pairing code can be used once. Open Workstations, click Add a workstation and copy the new command. Only the newest command works: starting the wizard again cancels the earlier one.',
      },
      {
        q: 'This page keeps saying "Waiting for you to run the command"',
        a: 'The installer has not reported in yet. Check that you ran the command on the computer that will host your agents, and that it can open this site in a browser (a company firewall or VPN may block it). If the installer printed an error, the line starting with [x] says what to fix.',
      },
      {
        q: 'Windows asked me to restart',
        a: 'Say yes. Turning on WSL2 (Linux inside Windows) needs one restart. Sign in as usual: the installer opens again by itself, and Windows may ask you to allow it. If it does not come back, run the command again.',
      },
      {
        q: 'Ubuntu asks me for a user name and password (Windows)',
        a: 'That is the Linux inside your PC, not your Windows login. Choose any name and a password you will remember: the installer asks for it again when it adds tools. Nothing shows on screen while you type a password; that is normal.',
      },
      {
        q: 'It says systemd is not running',
        a: 'The runner starts by itself from a systemd service. On Windows the installer switches systemd on in Ubuntu (it writes systemd=true to /etc/wsl.conf); if you see this message, run wsl --shutdown in PowerShell and run the install command again. On a server or container without systemd the runner is started in the background only and will not come back after a restart.',
      },
      {
        q: 'It says I need administrator rights',
        a: 'Installing git, bubblewrap and socat uses your administrator (sudo) password once. Ask whoever manages your computer to install them, or to add you to the sudoers, and run the command again.',
      },
      {
        q: 'git is too old',
        a: 'The runner needs git 2.40 or newer. The installer upgrades it on Ubuntu (from the official git PPA) and on Debian (it builds a recent git into your home folder, which takes a few minutes). On other systems install a newer git yourself and run the command again.',
      },
      {
        q: 'The health check "sandbox" is not "enforced"',
        a: 'Agents run inside a sandbox so they cannot read your SSH keys or other projects. On Linux and WSL2 it needs bubblewrap and socat; on Ubuntu 24.04 and newer an AppArmor setting can block bubblewrap (the Claude Code sandboxing documentation shows the one-line fix). macOS needs nothing. Until it says enforced, agents are not scheduled on that workstation.',
      },
      {
        q: 'Which Claude sign-in should I choose?',
        a: 'A Claude subscription (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and the agents’ work counts against your plan, with no per-use bill. An Anthropic API key: you pay for exactly what the agents use. Use whatever your organization gave you. You can also choose later and run claude on that computer when you are ready; the "claude" health check shows the state.',
      },
      {
        q: 'Docker or yt-dlp show a warning',
        a: 'Both are optional. Docker is only needed if your testers run containers; yt-dlp lets agents read video transcripts. Run the command again and say yes when it asks, or ignore the warning.',
      },
      {
        q: 'I still need help',
        a: 'Use Contact us and say which system you use and which step stopped. The form attaches the details we need.',
      },
    ],
  },
  {
    id: 'your-requests',
    title: 'Writing to us',
    intro:
      'Contact us is in the user menu and in the command palette (Ctrl K). Pick the type, write a subject and a message, and attach a screenshot if it helps: the form captures the page you were on and shows you exactly what it sends.',
    entries: [
      {
        q: 'Where do I see the answer?',
        a: 'We answer by email, and the answer also appears under Help, My requests, where you can reply. A request is open until we answer, answered until you write again, and closed when we are done.',
      },
      {
        q: 'What do you receive with my message?',
        a: 'Your name, email and organization, the page you were on, the app version, your browser, and the last few errors from your browser if you leave that box ticked. Nothing else is read from your account.',
      },
      {
        q: 'I cannot sign in',
        a: 'Use Contact us on the sign-in page: give your name and email and we answer by email.',
      },
    ],
  },
];
