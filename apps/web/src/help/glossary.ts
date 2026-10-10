import type { GlossaryEntry } from './types.ts';

/** The words Guildwise HQ uses, in plain language. Alphabetical in the Help centre. */
export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Agent',
    aka: ['bot', 'ai', 'employee'],
    definition:
      'One member of your AI team: a role (such as builder or reviewer), a seniority, a face and a track record. Agents work on cards and run on a workstation.',
    article: 'agents#hiring',
  },
  {
    term: 'Allow-list',
    aka: ['allowed projects', 'works on'],
    definition:
      'The projects an agent may work on. An agent is only offered cards from projects on its list; an empty list benches it.',
    article: 'agents#allow-lists',
  },
  {
    term: 'BA',
    aka: ['business analyst', 'reporter'],
    definition:
      'The business analyst agent. It turns your requests and tickets into cards, asks you what it cannot decide, and writes your daily floor report.',
    article: 'ba-reporter#what-goes-through-the-ba',
  },
  {
    term: 'Board',
    definition: 'The columns of cards of one project. Cards move across it by themselves as agents work.',
    article: 'board-and-cards#reading-the-board',
  },
  {
    term: 'Budget',
    aka: ['spending limit', 'cap'],
    definition:
      'A monthly spending limit for a project or an interest. When it is reached, new work pauses until you raise it or override it.',
    article: 'budgets-and-costs#monthly-budgets',
  },
  {
    term: 'Card',
    aka: ['ticket', 'task', 'work item'],
    definition:
      'One piece of work, written down with its requirements and acceptance criteria. A card moves through the stages of its workflow until it is done.',
    article: 'board-and-cards#creating-a-card',
  },
  {
    term: 'Delivery',
    aka: ['digest', 'delivery schedule'],
    definition:
      'When an interest sends you what it found: straight away, or as a digest at set times. It is separate from when the agent looks.',
    article: 'interests#run-and-delivery',
  },
  {
    term: 'Desk',
    aka: ['decision desk', 'inbox'],
    definition:
      'Your inbox of decisions. Anything an agent cannot decide alone, such as a question, an approval or a go-ahead, waits here for you.',
    article: 'desk#desk-items',
  },
  {
    term: 'DevOps engineer',
    aka: ['devops'],
    definition:
      'A free agent that looks after one workstation. It works as you, outside the sandbox: it installs tools and packages, keeps repositories and vaults in sync, runs hygiene, fixes conflicts and runs what you ask in a chat.',
    article: 'devops-and-hygiene#devops-engineer',
  },
  {
    term: 'Focus',
    definition:
      'What an agent should concentrate on within its allowed projects, for example a preferred project. It steers which cards the agent picks first.',
    article: 'agents#focus',
  },
  {
    term: 'Follow-up',
    aka: ['followup', 'phase follow-up'],
    definition:
      'Work that runs after a phase is finished, such as a deploy or a regression run, once you approve it on the desk.',
    article: 'phases#followups',
  },
  {
    term: 'Guest',
    definition:
      'Someone from another organization who was invited to one or more of your projects. A guest sees those projects and nothing else of the organization.',
    article: 'organizations-and-roles#guests',
  },
  {
    term: 'Handoff',
    aka: ['hand-off', 'hand over'],
    definition:
      'When a card passes from one agent or stage to the next, for example from builder to reviewer, with a note of what was done.',
    article: 'board-and-cards#moving-cards',
  },
  {
    term: 'Hygiene',
    aka: ['repository hygiene'],
    definition:
      'Routine tidying of a repository by the DevOps engineer: pulling the latest changes, keeping your unsaved edits on a saved-work branch, and removing the leftovers of finished cards.',
    article: 'devops-and-hygiene#hygiene',
  },
  {
    term: 'Interest',
    definition:
      'A topic you want an agent to keep an eye on. It looks on a schedule, learns from your ratings and sends you a digest.',
    article: 'interests#creating',
  },
  {
    term: 'Ledger',
    definition:
      'The searchable memory of your team: requirements, decisions and standing orders. Agents read it before they ask you anything.',
    article: 'ledger-and-vaults#ledger',
  },
  {
    term: 'Organization',
    aka: ['org', 'workspace'],
    definition:
      'The space that holds your projects, agents, members and budgets. You can belong to several and switch between them.',
    article: 'organizations-and-roles#roles',
  },
  {
    term: 'Phase',
    aka: ['milestone'],
    definition:
      'A group of cards that belong together, such as a release. When the last card is done the phase is done and its follow-ups can start.',
    article: 'phases#creating-a-phase',
  },
  {
    term: 'Priority order',
    aka: ['project rank', 'ranking'],
    definition:
      'The order of your projects on the Projects page, most important first. Agents serve the project higher up first. Owners and Admins change it by dragging.',
    article: 'projects#ranking',
  },
  {
    term: 'Quiet cap',
    aka: ['daily cap', 'digest cap'],
    definition:
      'The most items interests may send you in one day, so a busy day never floods you. The rest wait for the next digest.',
    article: 'interests#quiet-cap',
  },
  {
    term: 'Risk tier',
    definition:
      'How big and risky a change is: small or large. A large change needs two reviewers and, when merged, your approval on the desk.',
    article: 'board-and-cards#risk-tier',
  },
  {
    term: 'Runner',
    aka: ['aom-runner'],
    definition:
      'The small program on a workstation that connects it to Guildwise HQ and starts agents when there is work.',
    article: 'workstations-and-installer#what-is-a-workstation',
  },
  {
    term: 'Schedule',
    aka: ['trigger', 'automation'],
    definition:
      'Work that starts by itself: at a time of day, when something happens (such as a phase finishing), or when an issue gets a label. It has a trigger and an action.',
    article: 'schedules-and-integrations#schedules',
  },
  {
    term: 'Shift',
    aka: ['run', 'session'],
    definition:
      'One working session of an agent on a card, from picking it up to handing it on. A shift has a transcript and a cost.',
    article: 'board-and-cards#reading-the-board',
  },
  {
    term: 'Stage',
    aka: ['column', 'status'],
    definition:
      'One step of a workflow, shown as a column of the board, for example Spec, In progress, Review or Done.',
    article: 'board-and-cards#reading-the-board',
  },
  {
    term: 'Standing order',
    aka: ['rule'],
    definition:
      'A rule you give once and agents follow from then on, for example "always write tests". It is kept in the ledger.',
    article: 'desk#standing-orders',
  },
  {
    term: 'Taste',
    aka: ['taste rules'],
    definition:
      'What an interest has learned you like and dislike, from your ratings and your own rules. It decides what is worth sending you.',
    article: 'interests#taste-rules',
  },
  {
    term: 'Vault',
    definition:
      'A shared folder of markdown notes kept in a git repository and synced to your workstations, so agents read what you know.',
    article: 'ledger-and-vaults#vaults',
  },
  {
    term: 'Workflow',
    definition:
      'The stages a card passes through and who works on each one. A project uses one, and you can design your own.',
    article: 'org-chart-and-design#custom-workflows',
  },
  {
    term: 'Workstation',
    aka: ['machine', 'computer', 'host'],
    definition:
      'The machine that runs your agents: a computer of yours, a server you rent (VPS) or a GitHub Codespace. Nothing runs until you have added one with Add a workstation.',
    article: 'workstations-and-installer#add-a-workstation',
  },
  {
    term: 'Working branch',
    aka: ['default branch', 'main'],
    definition:
      'The main line of a repository (usually main) that agents start from and finished work goes into. Guildwise uses the repository default without asking, and asks only when it cannot tell.',
    article: 'devops-and-hygiene#working-branch',
  },
  {
    term: 'Cloud workstation',
    aka: ['vps', 'codespace', 'codespaces', 'server'],
    definition:
      'A workstation that is not your own computer: a Linux server you log in to over SSH, or a GitHub Codespace. It pairs itself, can sleep when idle and shows an estimated monthly cost.',
    article: 'cloud-workstations',
  },
  {
    term: 'Expert mode',
    aka: ['git expert mode', 'simple mode', 'git'],
    definition:
      'A personal setting that shows branch names and the git controls. Off by default: cards then say plain things such as "Your change is live on main".',
    article: 'testing-and-finalization#expert-mode',
  },
  {
    term: 'Free trial',
    aka: ['trial', 'plan', 'sign up', 'pricing'],
    definition:
      'Seven days of a paid plan at no cost, after you sign up, confirm your email and add a card. The first payment is taken when it ends; cancel before then and you pay nothing.',
    article: 'billing-and-plans#trial',
  },
  {
    term: 'Git host',
    aka: ['forge', 'github', 'gitlab', 'bitbucket', 'azure devops', 'plain git'],
    definition:
      'Where a repository lives: GitHub, GitLab, Bitbucket, Azure DevOps or a plain git server. Each repository has one, and the workstation connects to it with its own login.',
    article: 'workstations-and-installer#git-hosts',
  },
  {
    term: 'Get started checklist',
    aka: ['checklist', 'setup', 'get started'],
    definition:
      'The five steps from an empty organization to a working team (project, repository, workstation, team, talking to the BA). It ticks itself off and disappears when everything is done.',
    article: 'getting-started#get-started',
  },
  {
    term: 'Saved-work branch',
    aka: ['saved work', 'unsaved edits'],
    definition:
      'Where hygiene keeps a copy of edits you had not saved in a repository, so nothing is lost and nothing reaches main by surprise.',
    article: 'devops-and-hygiene#hygiene',
  },
];
