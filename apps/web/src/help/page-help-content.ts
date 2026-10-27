import type { PageHelp } from './types.ts';

export const PAGE_HELP: Record<string, PageHelp> = {
  '/p/:projectKey/archive': {
    title: 'Archive',
    article: 'board-and-cards#moving-cards',
    intro:
      'Done and cancelled cards leave the board a day after they were finished. They are listed here, newest first. Open a card to read it, or to reopen it: a reopened card is back on the board.',
    controls: [
      { name: 'Search', text: 'Find a card by reference, title or ticket key.' },
      {
        name: 'Status, Agent and dates',
        text: 'Narrow the list to done or cancelled cards, to one agent, or to a period.',
      },
    ],
  },
  '/p/:projectKey/backlog': {
    title: 'Backlog',
    article: 'board-and-cards',
    intro:
      'Wanted work for this project that is not in development. Nothing here is worked by an agent until you send it to the BA. Agents may add follow-ups they find as suggestions; you decide what happens to them.',
    controls: [
      {
        name: 'Add to the backlog',
        text: 'Type a title and press Enter (or tap Add). Fill in the details later with Edit.',
      },
      {
        name: 'Search and filters',
        text: 'Search title, description and tags. Filter by flagged, agent suggestions, status, priority and tag. Open items are shown by default.',
      },
      { name: 'Star', text: 'Flag an item you want to look at soon.' },
      {
        name: 'Send to BA',
        text: 'Hands the item to the BA as a new card on the board. The item becomes Done and links to the card. Select several items to send them together.',
      },
      { name: 'Drop', text: 'Takes an item off the backlog. Find it again with the Dropped filter.' },
    ],
  },
  '/p/:projectKey/board': {
    title: 'Board',
    intro:
      'The project board shows all cards in stages of work. Cards move by themselves as agents work; a card that is stuck says why in a banner under it. Click any card for details.',
    controls: [
      {
        name: 'Search cards',
        text: 'Find a card by title, reference or content. Escape clears the search.',
      },
      {
        name: 'Blocked filter',
        text: 'Show only blocked cards: the ones waiting for your answer at the desk. Useful when you have decisions pending.',
      },
      {
        name: 'Rework filter',
        text: 'Show only cards that review has sent back for fixes at least once.',
      },
      {
        name: 'Unassigned filter',
        text: 'Show only cards no agent is working on right now.',
      },
      {
        name: 'Priority picker',
        text: 'Filter cards by priority (urgent, high, normal, low). Open without a choice to show all.',
      },
      {
        name: 'Phase filter',
        text: 'Show cards in a specific phase. Phases break work into milestones; leave empty to see all phases.',
      },
      {
        name: 'Run regression',
        text: 'Queue a regression run for the testers on Web, Mobile or Both platforms. Shown only on projects with a test stage.',
      },
      {
        name: 'Convert to project',
        text: 'Convert a research project to a Code project (or another workflow) once its questions are answered. Shown on research projects to the Owner and Admins.',
      },
      {
        name: 'Settings',
        text: 'The gear opens the project settings: name, how finished work lands, repositories, phases, merging, budget, team and archiving.',
      },
      {
        name: 'New card',
        text: 'Create a new card to describe a piece of work.',
      },
      {
        name: 'Warning banners',
        text: 'Under a card: why it is blocked, a problem with its repository, or the monthly budget nearly or fully used, each with a link that fixes it. Tap the arrow for the full reason.',
      },
    ],
    article: 'board-and-cards#reading-the-board',
    tips: ['Press n to create a card', 'Press g then b to go to the board'],
  },
  '/p/:projectKey/research': {
    title: 'Research',
    intro:
      'The research cards of this project and the notes they published. A note is published once its claims are checked against their sources.',
    controls: [
      {
        name: 'New research card',
        text: 'Create a research card with a question, scope and depth.',
      },
      {
        name: 'In progress',
        text: 'Research cards that are still open, with the board column each one is in.',
      },
      {
        name: 'Published notes',
        text: 'The finished research notes, each linked to the card that produced it.',
      },
    ],
    article: 'projects#project-types',
  },
  '/p/:projectKey/environments': {
    title: 'Environments',
    intro:
      'Where your app runs, in one place: how to start it, the computers and servers it can use, the test copies of cards, the test site and the live site, and the rules before a release.',
    controls: [
      {
        name: 'Your app',
        text: 'The steps that start your app. Test copies and sites on a computer use them.',
      },
      {
        name: 'Add an environment',
        text: 'Add a test site, a live site or another copy of your app. Pick where it runs; nothing changes until you save and the Owner approves.',
      },
      {
        name: 'Places',
        text: 'The computers and servers this project can use. Add one once and choose it for any environment.',
      },
    ],
    article: 'phases#delivery-recipes',
  },
  '/p/:projectKey/phases/:number': {
    title: 'Phase',
    intro: 'A phase groups cards you want to ship together. See its cards, follow-ups, report and progress.',
    controls: [
      {
        name: 'Phase details',
        text: 'Change the name and description until the phase is final, then click Save.',
      },
      {
        name: 'Cards',
        text: 'The cards in the phase with their state and result. Add a card with Add a card, take one out with Remove, or, in expert mode, click Mark merged when the automatic check cannot see a merge.',
      },
      {
        name: 'Follow-ups',
        text: 'What runs after you approve the phase (deploys, regression runs, custom items) and how far each has got.',
      },
      {
        name: 'Reopen phase',
        text: 'Make the phase wait for its cards again. A reason is required.',
      },
      {
        name: 'Report and thread',
        text: 'The phase report, the follow-up results and the conversation about this phase.',
      },
    ],
    article: 'phases#phase-done',
  },
  '/automations': {
    title: 'Automations',
    intro:
      'Automate work with a trigger and an action: at a time, when something happens (a card reaches a stage, a ticket arrives), or when an issue gets a label.',
    controls: [
      {
        name: 'New automation',
        text: 'Open the three-step wizard: When (the trigger), What (the action) and Details.',
      },
      {
        name: 'Automation list',
        text: 'Your automations grouped by project, with the whole organization first. Each shows its trigger, next run and last run.',
      },
      {
        name: 'Run now',
        text: 'Run an automation once, straight away.',
      },
      {
        name: 'Send test',
        text: 'For webhooks: send a test delivery now. It is logged but never retried.',
      },
      {
        name: 'History',
        text: 'Every run with what triggered it, what it did and why it failed, plus the delivery log for webhooks and e-mails.',
      },
      {
        name: 'Edit, Pause or Resume, Delete',
        text: 'Change an automation, switch it off and on, or remove it. Automations for the whole organization are changed by the Owner and Admins only.',
      },
      {
        name: 'New secret',
        text: 'For webhooks: replace the signing secret. The new one is shown once.',
      },
    ],
    article: 'automations-and-integrations#triggers',
  },
  '/interests': {
    title: 'Interests',
    intro:
      'Interests are topics you follow. Each scans on a schedule, learns from your ratings and delivers digests at times you choose.',
    controls: [
      {
        name: 'New interest',
        text: 'Create an interest to start scanning a topic, configuring its schedule and delivery.',
      },
      {
        name: 'Status filter',
        text: 'Show active, paused or any interests. Paused interests do not scan until you reactivate them.',
      },
      {
        name: 'Search',
        text: 'Find an interest by name or description.',
      },
      {
        name: 'Show archived',
        text: 'Include archived interests in the list. Archived interests have stopped scanning.',
      },
      {
        name: 'Quiet cap',
        text: 'A limit on how many items all interests deliver together per day. Adjust it to avoid overwhelm.',
      },
    ],
    article: 'interests#run-and-delivery',
  },
  '/interests/:id': {
    title: 'Interest detail',
    intro:
      'Manage one interest: see its scans, its delivered digest, adjust settings and refine what it learns.',
    controls: [
      {
        name: 'Overview tab',
        text: 'The run and delivery schedules, the last run, what waits for delivery, the notes research published and who can see the interest.',
      },
      {
        name: 'Run log tab',
        text: 'History of all scans with results, errors or skips. Click a run to see what it found.',
      },
      {
        name: 'Digest tab',
        text: 'The items found and delivered, where you rate them.',
      },
      {
        name: 'Settings tab',
        text: 'Change what to collect, the run and delivery schedules, preferred agents and the budget. The vault is fixed once the interest has run.',
      },
      {
        name: 'Taste tab',
        text: 'Your explicit taste rules, and what the interest has learned from your ratings.',
      },
      {
        name: 'Run scan',
        text: 'Start a scan immediately instead of waiting for the schedule. Results are added to the digest.',
      },
      {
        name: 'Research this',
        text: "Ask a question at Quick, Standard or Deep depth. A researcher and fact checker publish a note in the interest's vault folder.",
      },
      {
        name: 'Deliver now',
        text: 'Shown as Deliver N now when items are waiting: put them on your desk ahead of the schedule, within the daily quiet cap.',
      },
      {
        name: 'More actions',
        text: 'Archive stops scanning and hides the interest (Restore brings it back). An archived interest can also be deleted permanently.',
      },
    ],
    article: 'interests#run-and-delivery',
  },
  '/cards/new': {
    title: 'New card',
    intro: 'Create a new card to describe a piece of work for the agents.',
    controls: [
      {
        name: 'Project',
        text: 'Choose which project the card belongs to.',
      },
      {
        name: 'Card type',
        text: 'The kind of work (feature, bug, support, refactor, docs and so on, depending on the workflow).',
      },
      {
        name: 'Title',
        text: 'A short name for the work.',
      },
      {
        name: 'Repository',
        text: "For code work: which repository. How the work lands follows the project's setting; in expert mode you can also pick a completion action: commit and push to the working branch, pull request, or push the card branch only.",
      },
      {
        name: 'Priority',
        text: 'Urgent, high, normal or low. Urgent cards are picked up first.',
      },
      {
        name: 'Docs needed',
        text: 'Tick it if a technical writer should document the change.',
      },
      {
        name: 'Workflow fields',
        text: 'Context, requirements, acceptance criteria, affected areas, constraints and the test plan (for research cards: question, scope and depth).',
      },
      {
        name: 'Save draft and Specify',
        text: 'Save draft keeps the card private until you are ready. Specify checks every required field and sends it on.',
      },
    ],
    article: 'board-and-cards#creating-a-card',
  },
  '/cards/:ref': {
    title: 'Card detail',
    intro:
      'Full details of one card: its status, workflow stage, assigned agent, test results and conversation thread.',
    controls: [
      {
        name: 'Status badge',
        text: "Draft, queued, claimed, blocked, waiting, done or cancelled. Only the project owner or the card's creator can move the card between stages.",
      },
      {
        name: 'Card type badge',
        text: 'Feature, bug, support, refactor, docs or another type defined in the workflow.',
      },
      {
        name: 'Rework badge',
        text: 'Shown if the card has been sent back for fixes. Indicates which rework round this is.',
      },
      {
        name: 'Claimed by',
        text: 'The agent currently working on the card. If none, work is queued waiting for an agent to claim it.',
      },
      {
        name: 'Workflow stepper',
        text: 'The stages the card passes through, with the current one highlighted.',
      },
      {
        name: 'Specify button',
        text: 'Send a draft on to be worked. It lists any required field that is still missing.',
      },
      {
        name: 'Edit button',
        text: 'Change the title, priority and the other fields (and the completion action in expert mode). Only while the card is a draft or queued and not yet claimed.',
      },
      {
        name: 'Move button',
        text: 'Override the workflow and move the card to another stage immediately. Requires a reason.',
      },
      {
        name: 'Release back-off button',
        text: 'If an agent failed and the card is in back-off, retry now instead of waiting.',
      },
      {
        name: 'More actions menu',
        text: 'Release (let another agent claim it), Re-home (forget its workstation and worktree) or Cancel card (a reason is required).',
      },
      {
        name: 'Ask DevOps',
        text: 'Ask the DevOps engineer for help with this card (a missing tool, a repository problem). The card is attached to the request.',
      },
      {
        name: 'What to build panel',
        text: "The card's specification: context, requirements, acceptance criteria, affected areas, constraints and test plan.",
      },
      {
        name: 'Thread',
        text: 'Conversation between you, agents and the BA. Add comments to ask questions or share updates.',
      },
      {
        name: 'Timeline',
        text: 'A log of every stage transition and activity on the card, with dates and reasons.',
      },
      {
        name: 'Handoffs',
        text: 'A record of work passed between stages: who did it, the outcome, and any notes.',
      },
      {
        name: 'Details panel',
        text: 'Stage, risk tier, how the work lands, docs needed, priority, phase and who answers its questions, in one place (the completion action and branch in expert mode).',
      },
      {
        name: 'Risk tier',
        text: 'Small or large, worked out from the diff. Click Change to override it with a reason; it sets how many reviewers are needed and whether a merge waits for you.',
      },
      {
        name: 'Who answers its questions',
        text: 'Choose whether only the card owner or any project manager can answer questions from agents.',
      },
    ],
    article: 'board-and-cards#editing-a-card',
  },
  '/projects': {
    title: 'Projects',
    intro:
      'A project is where work happens: its board, team of agents and repositories. Each project has its own workflow.',
    controls: [
      {
        name: 'New project',
        text: 'Create a project with a name, a key and a workflow (Code, Research or a custom one). Available to the Owner and Admins.',
      },
      {
        name: 'Active tab',
        text: 'Projects currently running. Most work happens here.',
      },
      {
        name: 'Archived tab',
        text: 'Archived projects. Restore one, or delete it permanently.',
      },
      {
        name: 'Department filter',
        text: 'Show projects in a specific department. Leave empty to see all departments.',
      },
      {
        name: 'Priority order',
        text: 'The projects of your organization, most important first. Agents take the next card from the highest project that has work, after scheduled work and their own rework. Owners and Admins change the order by dragging a project by its grip, or with the up and down buttons. A new project starts at the bottom.',
      },
      {
        name: 'Project row',
        text: 'Shows the priority number, the project name, key, workflow, department and whether you own it or it is shared with you. Click the name to open its board.',
      },
      {
        name: 'Shared with you',
        text: 'Projects of other organizations that you are a guest of. They are not part of your priority order.',
      },
      {
        name: 'Settings link',
        text: 'Open project settings to change its configuration.',
      },
    ],
    article: 'projects#creating-a-project',
    tips: ['Press g then p to go to projects'],
  },
  '/projects/:id/settings': {
    title: 'Project settings',
    intro:
      'Configure a project: its name, repositories, phases, merging, budget, team and archiving. The buttons at the top jump to each section.',
    controls: [
      {
        name: 'Basics',
        text: 'Project name, how finished work lands (commit and push to the working branch, or a pull request), architectural globs (for repos) and E2E test globs. Each repository shows its main branch (where pull requests go) and working branch (where card work is combined).',
      },
      {
        name: 'Stage',
        text: 'Which workflow the project runs on, and Convert project (Owner and Admins) to move it to another one.',
      },
      {
        name: 'Repos',
        text: "Add or remove repositories and set or change each one's git host. Paste a URL, pick one from your connected host, or create a new one with that host's fields. In expert mode you can also set or change each one's working branch. Only for projects whose workflow uses repositories.",
      },
      {
        name: 'Git host',
        text: 'Shows GitHub, GitLab, Bitbucket, Azure DevOps or Plain git for each repository, whether the workstation is connected to it, and a Connect button with the command to run. The owner can change it with Change.',
      },
      {
        name: 'Phases and Environments',
        text: 'Create phases here. Where your app runs, its start steps and the follow-ups of a new phase are on the Environments page (open it from the card here). For code projects.',
      },
      {
        name: 'Merging',
        text: 'Let large changes merge without your approval (project owner only, off by default).',
      },
      {
        name: 'Full test run',
        text: 'Tick or untick "Run the full end-to-end test suite after each finished card". On by default; Owners and Admins can switch it off if they do not want the extra "Full E2E suite" cards.',
      },
      {
        name: 'Budget',
        text: 'Set a monthly budget for what the agents cost. At 80% you are warned; at 100% new work pauses until you raise it or override it.',
      },
      {
        name: 'Team',
        text: 'Share the project with someone from another organization by email. They join as additional managers once they accept.',
      },
      {
        name: 'Archive',
        text: 'Archive the project (reversible). Permanent deletion is on the Projects page, under Archived.',
      },
      {
        name: 'Save settings',
        text: 'Apply changes to the project name, branch and globs.',
      },
    ],
    article: 'projects#creating-a-project',
  },
  '/agents': {
    title: 'Agents',
    intro:
      'Your team of AI agents. Hire, fire, change roles or models, and see performance metrics for each.',
    controls: [
      {
        name: 'Metrics link',
        text: 'Jump to the Metrics page to see team throughput and blocking time.',
      },
      {
        name: 'Hire agent',
        text: 'Hire an agent: role, seniority, workstation, runtime, model and effort, which projects it may work on, skills and a name.',
      },
      {
        name: 'Project filter',
        text: 'Show only agents allowed on a specific project.',
      },
      {
        name: 'Department filter',
        text: 'Show only agents in a specific department.',
      },
      {
        name: 'Role updates',
        text: 'Shown when an app update gives a built-in role a new default. Reset to default drops the extensions you added to that role.',
      },
      {
        name: 'Recommendations',
        text: 'Rule-based suggestions such as a model change, splitting a role or firing an idle agent, with the evidence. Some can be applied with one click.',
      },
      {
        name: 'Agent card',
        text: 'Name, role and seniority, status (idle, on shift, blocked or needs rehome), model, current card, who hired it, cost and performance stats.',
      },
      {
        name: 'Work quality panel',
        text: 'For builders: reviewer score, rework rounds per card, bugs escaped, criteria missed and test coverage of their changes.',
      },
      {
        name: 'Projects',
        text: 'Change where the agent may work: any project (Owner and Admins) or selected ones, with a star to prefer some. An empty list benches the agent.',
      },
      {
        name: 'Change model',
        text: 'Switch the agent to a different model or effort.',
      },
      {
        name: 'Change role',
        text: 'Move the agent to a different role.',
      },
      {
        name: 'Fire',
        text: 'Retire the agent. Its cards go back to the queue and its sandbox is wiped.',
      },
      {
        name: 'Re-home',
        text: 'Shown when an agent needs a new home (for example its manager was removed): pick one of your own workstations.',
      },
      {
        name: 'Reset (DevOps engineer)',
        text: "Wipe a DevOps engineer's sandbox. It stays assigned to its workstation.",
      },
      {
        name: 'Re-roll face',
        text: 'Give the agent a new generated face.',
      },
      {
        name: 'Retired section',
        text: 'Agents who have been fired. Kept for reference; they no longer work.',
      },
    ],
    article: 'agents#hiring',
    tips: ['Press g then a to go to agents', 'You can link to a specific agent with #<agent-id>'],
  },
  '/hr': {
    title: 'Agents',
    intro:
      'Your team of AI agents. Hire, fire, change roles or models, and see performance metrics for each.',
    controls: [
      {
        name: 'Metrics link',
        text: 'Jump to the Metrics page to see team throughput and blocking time.',
      },
      {
        name: 'Hire agent',
        text: 'Hire an agent: role, seniority, workstation, runtime, model and effort, which projects it may work on, skills and a name.',
      },
      {
        name: 'Project filter',
        text: 'Show only agents allowed on a specific project.',
      },
      {
        name: 'Department filter',
        text: 'Show only agents in a specific department.',
      },
      {
        name: 'Role updates',
        text: 'Shown when an app update gives a built-in role a new default. Reset to default drops the extensions you added to that role.',
      },
      {
        name: 'Recommendations',
        text: 'Rule-based suggestions such as a model change, splitting a role or firing an idle agent, with the evidence. Some can be applied with one click.',
      },
      {
        name: 'Agent card',
        text: 'Name, role and seniority, status (idle, on shift, blocked or needs rehome), model, current card, who hired it, cost and performance stats.',
      },
      {
        name: 'Work quality panel',
        text: 'For builders: reviewer score, rework rounds per card, bugs escaped, criteria missed and test coverage of their changes.',
      },
      {
        name: 'Projects',
        text: 'Change where the agent may work: any project (Owner and Admins) or selected ones, with a star to prefer some. An empty list benches the agent.',
      },
      {
        name: 'Change model',
        text: 'Switch the agent to a different model or effort.',
      },
      {
        name: 'Change role',
        text: 'Move the agent to a different role.',
      },
      {
        name: 'Fire',
        text: 'Retire the agent. Its cards go back to the queue and its sandbox is wiped.',
      },
      {
        name: 'Re-home',
        text: 'Shown when an agent needs a new home (for example its manager was removed): pick one of your own workstations.',
      },
      {
        name: 'Reset (DevOps engineer)',
        text: "Wipe a DevOps engineer's sandbox. It stays assigned to its workstation.",
      },
      {
        name: 'Re-roll face',
        text: 'Give the agent a new generated face.',
      },
      {
        name: 'Retired section',
        text: 'Agents who have been fired. Kept for reference; they no longer work.',
      },
    ],
    article: 'agents#hiring',
    tips: ['Press g then a to go to agents', 'You can link to a specific agent with #<agent-id>'],
  },
  '/metrics': {
    title: 'Metrics',
    intro:
      'What the team delivered, where it waited on you and where quality slipped: throughput, time blocked, bounce rate, escaped bugs, duration and queue depth.',
    controls: [
      {
        name: 'Project filter',
        text: 'Show metrics for a specific project or all projects combined.',
      },
      {
        name: 'Range buttons',
        text: 'Show data for the last 7, 14, 30 or 90 days.',
      },
      {
        name: 'Throughput',
        text: 'Cards finalized in the range, in total and per day.',
      },
      {
        name: 'Time blocked on you',
        text: 'Total time cards waited on desk answers, average per card and how many cards were held up.',
      },
      {
        name: 'Bounce rate per builder',
        text: 'For each builder, how often their cards were sent back for rework. Lower is better.',
      },
      {
        name: 'Bugs escaped past test',
        text: 'How many test runs failed, by day.',
      },
      {
        name: 'Duration',
        text: 'How many cards finished, with the average and median time per card.',
      },
      {
        name: 'Queue depth per column',
        text: 'How many cards sit in each board column right now. A long queue means agents are at capacity.',
      },
    ],
    article: 'agents#hr-board',
  },
  '/org': {
    title: 'Organization',
    intro:
      'Design your organization: define roles, create custom workflows, set up departments and draft them with the BA. Definitions are approved on the desk before they can be used. The Owner and Admins can change them.',
    controls: [
      {
        name: 'Organization selector',
        text: 'If you work on a shared project, switch between your own organization and the catalogue of the organization that owns it (read-only).',
      },
      {
        name: 'Roles tab',
        text: 'Custom roles (New custom role) and the built-in roles, which you can Extend with extra instructions, skills and standing orders.',
      },
      {
        name: 'Workflows tab',
        text: 'Built-in and custom workflows (New custom workflow). Each stage names the role that claims it and where the card goes next.',
      },
      {
        name: 'Departments tab',
        text: 'Departments group roles and workflows by function, so the Agents and Projects pages can be filtered by department.',
      },
      {
        name: 'Design with the BA tab',
        text: 'Pick a business analyst and describe the role or workflow you need. The BA drafts it, validates it and puts it on your desk.',
      },
      {
        name: 'Role editor',
        text: 'Define a role: purpose, instructions, core rules, seniority levels, default model, tools and the workflow stages it may claim. Save draft, or Save and submit for approval.',
      },
      {
        name: 'Workflow builder',
        text: 'New custom workflow, Edit and New version open the workflow builder: a step list with a live diagram, plain-language problems and a Try a card preview. Compare with previous shows what changed between versions.',
      },
      {
        name: 'Workflow graph',
        text: 'Visual preview of a workflow showing all stages and how cards flow through them.',
      },
      {
        name: 'Status badges',
        text: 'Active (in use), Draft (being edited), Waiting for your approval (approve it on the desk), Rejected, or Replaced by a newer version.',
      },
    ],
    article: 'org-chart-and-design#custom-roles',
  },
  '/org/workflows/:draftId': {
    title: 'Workflow builder',
    intro:
      'Build a custom workflow as a list of steps with a live diagram. Problems are listed in plain words, Try a card shows the path a card takes, and a finished workflow is sent to the desk for approval.',
    controls: [
      {
        name: 'Steps',
        text: 'One card per step: its name, what done looks like, who does it, what must be filled in first, where it goes when finished, where it is sent back to, and an optional Only when condition. Add, move and remove steps with the buttons.',
      },
      {
        name: 'Information the card carries',
        text: 'The extra fields of the cards in this workflow: a name, a kind (text, number, yes or no, list, links) and whether it must be filled in.',
      },
      {
        name: 'Things to fix',
        text: 'Every problem in plain words. Pick one to jump to its step. Problems block sending for approval; tips do not.',
      },
      {
        name: 'Diagram and Try a card',
        text: 'The diagram redraws as you edit. Try a card walks a card through the steps with the answers you tick and marks its path on the diagram.',
      },
      {
        name: 'Ask the BA',
        text: 'A chat about the current draft. The BA reads an outline of it and answers questions; you make the changes here.',
      },
      {
        name: 'Save draft, Save and send for approval',
        text: 'Save keeps the draft; send for approval puts it on the desk where Owners and Admins approve it.',
      },
      {
        name: 'Versions',
        text: 'All saved versions, with Compare with previous to see what changed step by step. Edit as new version starts the next one from an approved version.',
      },
      {
        name: 'Advanced: table editor',
        text: 'The original table with internal ids, events and every route, for workflows the step list shows only in part.',
      },
    ],
    article: 'org-chart-and-design#workflow-builder',
  },
  '/org-chart': {
    title: 'Org chart',
    intro: 'See who is on the floor, their reporting lines and who answers questions for each role.',
    controls: [
      {
        name: 'Chart view',
        text: 'Visual org chart showing reporting lines and question escalation paths.',
      },
      {
        name: 'List view',
        text: 'A list of all agents grouped by department, with their role, workstation and status.',
      },
      {
        name: 'View toggle',
        text: 'The View switch: Chart or List. The chart works best on wide screens; phones show the list.',
      },
      {
        name: 'Project filter',
        text: 'Show only agents allowed on a specific project. Agents allowed on any project always appear.',
      },
      {
        name: 'Agent details',
        text: 'Click any agent to see its projects, focus, who it reports to and escalates to, workstation, spend and recent work.',
      },
      {
        name: 'Agent status',
        text: 'Each tile says in words what the agent is doing: working, blocked, idle or offline.',
      },
      {
        name: 'DevOps engineers',
        text: 'Shown apart from the chart, one per workstation, reporting to your desk rather than to the BA.',
      },
    ],
    article: 'org-chart-and-design#org-chart',
  },
  '/org/ceo': {
    title: 'CEO',
    intro:
      'Your organization has a built-in CEO agent that works your desk and the floor inside limits you set. It decides within your policy from day one, every decision can be undone, and Pause stops it at once.',
    controls: [
      {
        name: 'Overview',
        text: 'The CEO state, where it runs, its spend and the Pause button (an emergency stop).',
      },
      {
        name: 'Authority',
        text: 'For each kind of action choose whether the CEO decides, recommends or never does it.',
      },
      {
        name: 'Activity log',
        text: 'Everything the CEO decided, recommended or refused, with an Undo where one exists.',
      },
      {
        name: 'Memory',
        text: 'The rules the CEO remembers. Only the Owner can read and change them.',
      },
    ],
    article: 'your-ceo',
  },
  '/costs': {
    title: 'Costs',
    intro:
      'Track what your agents cost: spending by project, agent, model and day. Budgets are set in the project settings.',
    controls: [
      {
        name: 'This month',
        text: 'Show costs for the current month.',
      },
      {
        name: 'Last 30 days',
        text: 'Show costs for the last 30 days.',
      },
      {
        name: 'Last month',
        text: 'Show costs for the previous calendar month.',
      },
      {
        name: 'From and To',
        text: 'Pick start and end dates to see costs for any period.',
      },
      {
        name: 'Project filter',
        text: 'Show costs for a specific project or all projects combined.',
      },
      {
        name: 'Currency and prices',
        text: 'Set your currency code and the rate against USD, and see the list prices used.',
      },
      {
        name: 'Total spend',
        text: 'Estimated cost of all shifts in the period, worked out from tokens at list prices. Not an invoice.',
      },
      {
        name: 'Breakdown by project',
        text: 'See which projects are costing the most and where to optimize.',
      },
      {
        name: 'Breakdown by agent',
        text: 'Which agents are most expensive. Use this to benchmark agent productivity.',
      },
      {
        name: 'Daily spend chart',
        text: 'Spending over time, showing trends and spike days.',
      },
      {
        name: 'Export CSV',
        text: 'Download costs data for analysis in a spreadsheet or accounting system.',
      },
      {
        name: 'What the agents delivered',
        text: 'Cards finished this month, estimated hours of work, usage and return. Adjust the estimates there.',
      },
    ],
    article: 'budgets-and-costs#monthly-budgets',
  },
  '/releases': {
    title: 'Releases',
    intro:
      'Everything about putting a new version of your app on a live site. Waiting for you lists versions that are ready; What is live shows the version on every site; History shows what was released and why it was allowed; Rules says what must be true first.',
    controls: [
      {
        name: 'Release',
        text: 'Puts the waiting version on the live site, using the setup the Owner approved. If the site has several places, tick the ones to release to. The rules are checked again at the moment you press it.',
      },
      {
        name: 'What is live',
        text: 'One row per project and site: the version, since when, whether it is healthy, and where it runs. Everyone in the organization can look; only the Owner or an Admin can release.',
      },
      {
        name: 'Rules',
        text: 'What must be true before a release, in plain sentences: for example the test site is healthy on the same version for 10 minutes. Freeze stops every release until you lift it.',
      },
    ],
    article: 'phases#delivery-recipes',
  },
  '/workstations': {
    title: 'Workstations',
    intro:
      'The machines that run your agents: your own computers, a VPS or a GitHub Codespace. Add a workstation with the wizard, or pair one with a code.',
    controls: [
      {
        name: 'Add a workstation',
        text: 'Launch the setup wizard: install the runner on your own computer, on a VPS over SSH, or in a GitHub Codespace, and pair it with your organization.',
      },
      {
        name: 'Pair with a code',
        text: 'If the wizard is not available, pair with a one-time code.',
      },
      {
        name: 'Where agents run',
        text: 'In the wizard, choose My computer (the installer), A VPS (SSH: any Linux server) or GitHub Codespaces. You pay your VPS company or GitHub; Guildwise adds no charge.',
      },
      {
        name: 'Cloud workstations',
        text: 'Servers and Codespaces you added: whether they are running or asleep, Wake and Stop, the estimated monthly cost, how long they idle before stopping and optional office hours. A Codespace cannot run Docker, so keep a workstation or VPS for Docker deploys.',
      },
      {
        name: 'Workstation card',
        text: 'Name, system and runner version, whether it is connected, and an Unpair button. Click the name to expand: runtimes, shifts running, repositories and the DevOps engineer panel.',
      },
      {
        name: 'Git hosts',
        text: 'In the expanded card: whether this workstation is connected to GitHub, GitLab, Bitbucket and Azure DevOps. Connect shows the command to run on that computer; Check again refreshes the status. Your login stays on the workstation.',
      },
      {
        name: 'Connection dot',
        text: 'Says Connected or Offline. Offline means the runner has stopped or lost its connection.',
      },
      {
        name: 'Runtime warnings',
        text: 'Alerts if a runtime runs agents without an OS sandbox, or cannot run them at all (for example native Windows).',
      },
      {
        name: 'DevOps engineer panel',
        text: 'What the DevOps engineer may do on its own (install, Docker, sudo, extra paths), Repository hygiene (how often, and Run hygiene now), Ask DevOps (a quick request, or Ask DevOps in a chat that works on the machine), and its requests.',
      },
      {
        name: 'Unpair',
        text: 'Disconnect a workstation for good. Its runner token is revoked, cards claimed there go back to the queue and its agents wait to be re-homed.',
      },
    ],
    article: 'workstations-and-installer#add-a-workstation',
  },
  '/integrations': {
    title: 'Integrations',
    intro:
      'Every login a workstation needs, in one place: Claude, git hosts, Jira and MCP servers. Connect from the browser; your token is encrypted for that workstation.',
    controls: [
      {
        name: 'Tile',
        text: 'One integration: whether it is connected, as whom, missing scopes, expiry and when it was last checked.',
      },
      {
        name: 'Connect, Replace, Test, Remove',
        text: 'Connect or replace asks for the fields, encrypts them in your browser and lets the workstation check them with the provider. A greyed-out button says why.',
      },
      {
        name: 'From a terminal',
        text: 'The command to run on the workstation instead, for headless machines.',
      },
      {
        name: 'AI runtime',
        text: "One tile per program or provider (Codex, the Gemini CLI, Anthropic, OpenAI and others): whether it is installed, who is signed in and whose key is in effect. Sign in runs the program's own login on the workstation, Set key stores a key for it, Add a named account makes another login or key, and Make main swaps a named account with the main one.",
      },
    ],
    article: 'integrations',
  },
  '/settings': {
    title: 'Settings',
    intro:
      'Your personal preferences: picture, expert mode for code changes, the weekly blog digest, time zone and two-factor security.',
    controls: [
      {
        name: 'Your picture',
        text: 'A cartoon face, photo or custom image that shows in the sidebar, account menu and on your desk answers.',
      },
      {
        name: 'Change picture',
        text: 'Pick a generated cartoon face, take a photo or upload your own image.',
      },
      {
        name: 'Expert mode for code changes',
        text: 'Off by default: cards speak in plain results and Guildwise takes care of branches. Tick Show me branches and git controls to see branch names, choose how each card lands and use the manual merge controls. Only changes what you see.',
      },
      {
        name: 'Two-factor security',
        text: 'Set up two-factor login with an authenticator app, get new recovery codes or turn it off (not possible when your organization requires it).',
      },
      {
        name: 'Your time zone',
        text: "Set your time zone. The CEO's daily report follows the Owner's time zone.",
      },
      {
        name: 'Use this browser zone',
        text: 'Auto-detect and save your browser time zone. Suggested if it differs from your saved zone.',
      },
      {
        name: 'Weekly blog digest',
        text: 'One email on Monday mornings with the new blog articles. On by default for Owners, off for everyone else until you tick it.',
      },
    ],
    article: 'getting-started#the-tour',
    tips: [
      "Your picture, time zone and two-factor login are personal to your account. The CEO's report time (on the CEO page) applies to the whole organization.",
    ],
  },
  '/settings/vaults': {
    title: 'Vaults',
    intro:
      'Git repositories of markdown notes that your agents read and your DevOps engineers keep in sync on your workstations. The app stores only the URLs and the sync status.',
    controls: [
      {
        name: 'Register a vault',
        text: 'Add the organization vault (Owner and Admins) or a project vault by its git URL and sync interval. Agents never see credentials: the workstation uses its own git access.',
      },
      {
        name: 'Vault card',
        text: "The vault's kind, git URL and sync interval, and for each workstation whether it is synced, waiting or in error, with the last pull and push.",
      },
      {
        name: 'Edit',
        text: "Change the vault's git URL or sync interval.",
      },
      {
        name: 'Sync paused: conflict',
        text: 'A change conflicts with a remote one. Fix the listed files in the clone on your workstation, then click I resolved it, resume.',
      },
    ],
    article: 'ledger-and-vaults#vaults',
  },
  '/settings/capabilities': {
    title: 'Capabilities',
    intro:
      'The skills, personas and playbooks your agents can use, the packs that add more, and the ones you write yourself. Owners and Admins manage packs; everyone writes their own.',
    controls: [
      {
        name: 'My capabilities',
        text: 'Write skills, personas and playbooks. Private ones stay on your workstation and only you see them; organization ones are reviewed by an Owner or Admin. Export as a git-ready folder any time.',
      },
      {
        name: 'Hire from this pack',
        text: 'Turn a persona of an approved pack into an agent, tagged with where it came from. Add all agents at once from the review list.',
      },
      {
        name: 'Registry',
        text: 'Every capability with where it comes from. Filter by kind and source. A pack item says needs approval or files changed until it can be used.',
      },
      {
        name: 'Add a pack',
        text: 'Add a git repository at a tag or commit. It stays untrusted: nothing of it is used until you approve it.',
      },
      {
        name: 'Review and approve',
        text: 'Read the capabilities and files (scripts flagged) and approve that exact commit and content. Scripts stay off.',
      },
      {
        name: 'Check for updates',
        text: 'Looks for a newer commit and shows what changed. Accept it to use it.',
      },
      {
        name: 'Skill grants',
        text: 'Which skills each role has, resolved against the registry.',
      },
    ],
    article: 'capabilities#packs',
  },
  '/persona-chats/:id': {
    title: 'Chat with a persona',
    intro:
      'A one-to-one chat with a persona that is not hired, on your own workstation. It can read skills and search the ledger and does nothing else.',
    controls: [
      {
        name: 'Message box',
        text: 'Write and press Enter. A reply that cannot run now waits for your workstation.',
      },
      { name: 'Cost', text: 'What the chat has cost so far; it is part of the organization costs.' },
    ],
    article: 'capabilities#chat-with-a-persona',
  },
  '/settings/providers': {
    title: 'Model providers',
    intro:
      "Keys your whole organization can use, with a monthly spend cap per provider. Owners and Admins manage them. A workstation's own key overrides the organization's and is not capped.",
    controls: [
      {
        name: 'Set key / Replace key',
        text: 'Enter the key once. Your browser encrypts it for each workstation you tick; Guildwise stores only those encrypted copies and the runners decrypt them.',
      },
      {
        name: 'Workstations',
        text: 'Which workstations hold the key. A workstation that joined later shows Not shared: Share from another workstation (its runner re-seals the key, you do not type it again) or Enter the key again.',
      },
      {
        name: 'Monthly cap',
        text: 'The most the organization key may spend on this provider in a calendar month, in US dollars. You get a notice at 80% and 100%; at 100% new runs on the organization key are refused until you raise the cap, override it for this month, or the month ends. Runs with an unknown price are listed but cannot be counted.',
      },
      {
        name: 'Revoke',
        text: 'Removes the organization key from every workstation.',
      },
    ],
    article: 'ai-runtimes#keys',
  },
  '/settings/org': {
    title: 'Organization',
    intro: 'Manage your organization: members, invitations, guests, plan and billing.',
    controls: [
      {
        name: 'General tab',
        text: 'The organization name, its Owner, Transfer ownership and the Require two-factor login switch (Owner only). Other members can Leave organization here.',
      },
      {
        name: 'Members tab',
        text: 'Everyone in the organization with their role, projects and 2FA state. Owner and Admins can Invite member, change projects or remove people; only the Owner changes roles or resets two-factor login. Owner and Admins can reset a password (a temporary one, shown once): Admins for Members, the Owner for Members and Admins.',
      },
      {
        name: 'Invitations tab',
        text: 'Pending and past invitations. Resend or Revoke one. Owner and Admins only.',
      },
      {
        name: 'Guests tab',
        text: 'People from other organizations who have access to your projects, and which ones. Owner and Admins only.',
      },
      {
        name: 'E-mail inbox tab',
        text: 'Addresses that turn incoming mail into draft cards, with Copy, New address, an allow-list of senders (Owner only) and the recent messages with what became of each. Owner and Admins only.',
      },
      {
        name: 'Plan & limits tab',
        text: 'Your plan and status, usage against the limits and the features switched on. Plans limit members, projects and workstations, never agents. Owner and Admins only.',
      },
      {
        name: 'Billing tab',
        text: 'Owner only. Your plan (US dollars, VAT included), status, next charge, card and invoices; edit the billing profile printed on invoices, open a printable tax invoice, change plan, add members, workstations or projects on Business, cancel, or resubscribe when paused.',
      },
      {
        name: 'Your role',
        text: 'Shown under the page title: Owner, Admin or Member. Admins cannot invite Admins, change roles or change the security settings.',
      },
    ],
    article: 'organizations-and-roles#roles',
  },
  '/desk': {
    title: 'Your desk',
    intro:
      'Questions, approvals and alerts from your agents waiting on your answer. Answer them to keep work moving.',
    controls: [
      {
        name: 'All filter',
        text: 'Show every open item on the desk.',
      },
      {
        name: 'Blocking filter',
        text: 'Show only items that prevent cards from moving. Highest priority.',
      },
      {
        name: 'Questions filter',
        text: 'Show only questions and escalations from agents.',
      },
      {
        name: 'Approvals filter',
        text: 'Show only approvals: large merges, DevOps requests, outbound updates, repository creation and the like.',
      },
      {
        name: 'Notices filter',
        text: 'Show only alerts and heads-up notices from agents and the system.',
      },
      {
        name: 'Sort by priority',
        text: 'Reorder by urgency, blocking status and pinned items first.',
      },
      {
        name: 'Sort oldest/newest',
        text: 'Show items in time order so you can handle first-in-first-out or LIFO.',
      },
      {
        name: 'Add to ledger',
        text: 'Add a standing order, requirement or decision straight to the ledger, without a question.',
      },
      {
        name: 'Intake',
        text: 'Start an intake: bring a Jira or GitHub ticket, or a described need, in through the BA.',
      },
      {
        name: 'Chat',
        text: 'Open a chat with the BA, DevOps or any agent you may direct.',
      },
      {
        name: 'Desk item',
        text: 'One question, approval or alert. Shows who asked, what they were doing and options for your answer.',
      },
      {
        name: 'Urgent badge',
        text: 'Pinned items that need you first. Handle these before anything else.',
      },
      {
        name: 'Kind badge',
        text: 'Shows if it is a question, escalation, approval, alert or heads-up.',
      },
      {
        name: 'Blocking badge',
        text: 'This item is holding up work. Answer it to unblock cards.',
      },
      {
        name: 'Affects count',
        text: 'How many cards are waiting on this item.',
      },
      {
        name: 'Options',
        text: 'Suggested answers to choose from. The asker may have marked one as recommended.',
      },
      {
        name: 'Answer field',
        text: 'Type a custom answer if the options do not fit. Replaces any selected option.',
      },
      {
        name: 'Add to ledger dropdown',
        text: 'Choose how your answer is saved in the ledger: Decision (the default), Requirement, or a Standing order for this project or every project.',
      },
      {
        name: 'Answer button',
        text: 'Send your answer. The asker receives it and continues work.',
      },
      {
        name: 'Dismiss button',
        text: 'Close the item without answering. The asker is told you declined.',
      },
      {
        name: 'Approve/Reject buttons',
        text: 'For approval items, click to approve or reject. Some approvals are editable before approving.',
      },
      {
        name: 'Acknowledge button',
        text: 'For alerts and notices, acknowledge that you have seen them.',
      },
      {
        name: 'Answered and closed',
        text: 'Show closed items and their answers. Useful to review recent decisions or find a previous answer.',
      },
    ],
    article: 'desk#answering',
    tips: ['Press g then d to go to the desk', 'Items are grouped by priority to show what needs you most'],
  },
  '/help': {
    title: 'Help',
    intro:
      'Guildwise HQ documentation with articles on features, how-tos, a glossary and a form to contact support.',
    controls: [
      {
        name: 'Help centre tab',
        text: 'Searchable articles on every feature: the board, desk, agents, roles, workflows and more.',
      },
      {
        name: 'Getting started video',
        text: 'A spoken tutorial of under three minutes, from an empty organization to a team at work, with captions (CC). Each chapter under the video jumps to that part. The same video is the first step of the guided tour.',
      },
      {
        name: 'Get started checklist',
        text: 'Shows how far your organization is set up (project, repository, workstation, team, business analyst). Open it, or bring it back if you hid it.',
      },
      {
        name: 'Blog tab',
        text: 'The Guildwise HQ blog, read inside the app. The search box also finds blog articles.',
      },
      {
        name: 'Contact us tab',
        text: 'A form to write to support. Your message includes your browser and current page for context.',
      },
      {
        name: 'My requests tab',
        text: 'All your support tickets and responses. Check here for answers from the support team.',
      },
      {
        name: 'What’s new',
        text: 'Opens the list of recent changes for your role, newest first, including the ones you have already seen.',
      },
      {
        name: 'Articles',
        text: 'Read about features, workflows, troubleshooting and best practices.',
      },
      {
        name: 'Glossary',
        text: 'Definitions of Guildwise HQ terms: card, agent, role, workflow, desk and more.',
      },
      {
        name: 'Tour replay',
        text: 'Watch the guided tour again to remember key features. It starts with the getting-started video, then walks through the sidebar.',
      },
    ],
    article: 'getting-started#page-help',
  },
  '/ledger': {
    title: 'Ledger',
    intro:
      'Requirements, decisions and standing orders that agents consult before they ask you. The source of truth for context.',
    controls: [
      {
        name: 'Search',
        text: 'Find an entry by title or content. Use this when you remember what was said but not when.',
      },
      {
        name: 'Scope filter',
        text: 'Show all, standing orders only, decisions only or requirements only.',
      },
      {
        name: 'Project filter',
        text: 'Show entries for a specific project or entries that apply to all projects.',
      },
      {
        name: 'Add entry',
        text: 'Create a new decision, standing order or requirement. Use this to set policy without creating a card.',
      },
      {
        name: 'Standing order badge',
        text: 'Amber. Something agents always do or check before acting.',
      },
      {
        name: 'Decision badge',
        text: 'Blue. A choice you made that applies to future similar situations.',
      },
      {
        name: 'Requirement badge',
        text: 'Violet. A feature or capability that cards should build or respect.',
      },
      {
        name: 'Entry title and body',
        text: 'The policy or note. Entries can be expanded to see the full text.',
      },
      {
        name: 'Show more/less',
        text: 'Toggle to expand or collapse long entries.',
      },
    ],
    article: 'ledger-and-vaults#ledger',
  },
  '/chat/:threadId': {
    title: 'Chat',
    intro:
      'A conversation with one agent (the BA, DevOps or another agent you may direct). Ask, suggest or discuss without a formal desk item.',
    controls: [
      {
        name: 'Message thread',
        text: 'Back-and-forth conversation. You can see the full history.',
      },
      {
        name: 'Send message',
        text: 'Type and send a message. The agent replies while its workstation is connected.',
      },
    ],
    article: 'chat-with-agents',
  },
  '/ceo-chat': {
    title: 'Chat with the CEO',
    intro:
      'Your conversation with the CEO as a full page: the history, the message box, and your earlier CEO chats.',
    controls: [
      {
        name: 'Message thread',
        text: 'Back-and-forth conversation with the CEO. You can see the full history.',
      },
      {
        name: 'New chat',
        text: 'Start a fresh conversation (an empty chat is reused). The earlier one stays under Earlier, and you can still open it and write in it.',
      },
      { name: 'Earlier', text: 'Open one of your previous chats with the CEO.' },
    ],
    article: 'chat-with-agents',
  },
  '/discovery': {
    title: 'Discovery',
    intro:
      'Discovery sessions turn an idea into a brief or a PRD with an analyst. Each one keeps its own notes, cost and drafts.',
    controls: [
      {
        name: 'New discovery',
        text: 'Start a session: title, optional project and starting idea, how the analyst works, whether the CEO takes part, a time box and a budget.',
      },
      {
        name: 'A session row',
        text: 'Shows the phase, the stance, what it has cost so far and when it last moved. Click it to carry on where you left off.',
      },
    ],
    article: 'discovery#start',
  },
  '/discovery/:id': {
    title: 'Discovery session',
    intro:
      'The conversation with the analyst, the side panel of ideas and decisions, and the draft document.',
    controls: [
      {
        name: 'Question card',
        text: 'Pick a quick answer, write your own, skip it or park it for later. When the CEO took part, its proposal is shown next to the question: confirm, edit or override it.',
      },
      {
        name: 'Proposal',
        text: 'A change the analyst suggests. Nothing changes until you choose Apply; Reject drops it and Redirect sends your own words back.',
      },
      {
        name: 'Phase',
        text: 'Frame, Diverge, Converge, Stress test, Capture. The analyst moves on; click a phase to override it.',
      },
      {
        name: 'Pause and Resume',
        text: 'Stops the clock and anything new from starting. Nothing is lost, also across days.',
      },
      {
        name: 'Cost and budget',
        text: 'What the session has cost so far. With a budget set, no new turn starts once it is used up; raise it to continue.',
      },
      {
        name: 'Panel',
        text: 'Ideas, assumptions, open questions, decisions and parked items. You can add, edit, move and delete.',
      },
      {
        name: 'Draft',
        text: 'The brief or PRD with its versions and the checklist result. Approve it, then Hand to BA to start an intake with the PRD linked.',
      },
    ],
    article: 'discovery#conversation',
  },
  '/boardroom': {
    title: 'Boardroom',
    intro:
      'A boardroom puts one question to a cast of personas and agents, run by a Chair. Each one keeps its own conversation, whiteboard, cost and minutes.',
    controls: [
      {
        name: 'New boardroom',
        text: 'Start a session: the topic and brief, the format, the cast (library personas, your agents, personas cast from a one-line brief, or a saved room), an optional round cap (empty means none), a budget and the models.',
      },
      {
        name: 'A boardroom row',
        text: 'Shows the round, the format, the number of seats, what it has cost and when it last moved. A badge says when the Chair needs your decision.',
      },
    ],
    article: 'boardroom#start',
  },
  '/boardroom/:id': {
    title: 'Boardroom session',
    intro:
      'The group conversation, the whiteboard, the cost meter and the minutes. Everyone answers on their own first; the Chair runs the rounds after that.',
    controls: [
      {
        name: 'Sealed answers',
        text: 'In round 1 nobody sees the others. The answers are hidden until the last one is in, then revealed together.',
      },
      {
        name: 'Chair picks',
        text: 'Who speaks in the next round and why. The Chair never picks the same speaker twice in a row, and always includes a seat you @mentioned.',
      },
      {
        name: 'Decision card',
        text: 'The Chair stops when only you can decide. Pick an option or write your own, and the session goes on.',
      },
      {
        name: 'Message box',
        text: 'Interject at any time. Type @ to call on a seat by name, or @all for everyone; they speak in the next round.',
      },
      {
        name: 'Whiteboard',
        text: 'Ideas, risks, questions, decisions and parked items. Drag a note to another column, vote +1, merge notes, edit or delete.',
      },
      {
        name: 'Cost meter',
        text: 'What the session has cost and what the next round will cost about. With a budget set, no new turn starts once it is used up.',
      },
      {
        name: 'End session',
        text: 'Stops the debate and has the Chair write the minutes. The session also ends at the time or cost limit, or at a round cap if you set one.',
      },
      {
        name: 'Minutes and Pull into PRD',
        text: 'The minutes are saved as a document. Pull into PRD starts a Discovery session in the capture phase, seeded from them.',
      },
    ],
    article: 'boardroom#session',
  },
  '/documents': {
    title: 'Documents',
    intro: 'Briefs, PRDs, minutes and session logs of your organization.',
    controls: [
      { name: 'Filters', text: 'Narrow the list by kind (brief, PRD, minutes) or by status.' },
      { name: 'A document', text: 'Click one to read it, see its versions and change its status.' },
    ],
    article: 'discovery#documents',
  },
  '/documents/:id': {
    title: 'Document',
    intro: 'One document as formatted text, with its version history and status.',
    controls: [
      { name: 'Version', text: 'Pick an earlier version to read it. The current version is the default.' },
      {
        name: 'Approve and Reopen',
        text: 'Owners and Admins approve a document (it is then copied to the vault) or reopen it to edit again.',
      },
    ],
    article: 'discovery#documents',
  },
  '/intake': {
    title: 'New intake',
    intro:
      'Bring work in from Jira or GitHub, or describe a need. Your BA reads it, asks what it cannot decide and drafts the cards.',
    controls: [
      {
        name: 'Ticket or need',
        text: 'A Jira key (ABC-123), a GitHub issue (acme/web#12 or its URL), or a plain description. The page shows what it detected.',
      },
      {
        name: 'Start intake',
        text: 'Open a conversation with your BA about it.',
      },
      {
        name: 'Batch',
        text: 'Paste many tickets, one per line. The BA works through them in the background and asks on the desk when stuck.',
      },
      {
        name: 'Earlier intakes',
        text: 'Your previous intakes. Click one to pick the conversation up again.',
      },
    ],
    article: 'intake-and-outbox#intake',
  },
  '/intake/:id': {
    title: 'Intake view',
    intro: 'One intake: your conversation with the BA and the cards it has drafted from it.',
    controls: [
      {
        name: 'Conversation',
        text: "Answer the BA's questions about scope and project here.",
      },
      {
        name: 'Cards created',
        text: 'The cards drafted from this intake. Click one to review it and Specify it.',
      },
      {
        name: 'Pick the project',
        text: 'Shown when the BA could not map the ticket to a project: it takes you to the desk question.',
      },
    ],
    article: 'intake-and-outbox#intake',
  },
  '/intake/batches/:id': {
    title: 'Batch intake',
    intro:
      'One batch of tickets: what the BA has done with each, the cards it created and the questions it asked.',
    controls: [
      {
        name: 'Ticket status',
        text: 'Queued, BA is working, Waiting for you, Done, Skipped (already has a card), Failed or Cancelled.',
      },
      {
        name: 'Answer on the desk',
        text: 'Shown for a ticket the BA could not go on with: your answer on the desk resumes that ticket.',
      },
      { name: 'Retry', text: 'Ask the BA to try a failed ticket again.' },
      {
        name: 'Cancel batch',
        text: 'Stops the tickets that are not started or are waiting; tickets the BA is working on finish.',
      },
    ],
    article: 'intake-and-outbox#intake',
  },
  '/platform': {
    title: 'Organizations',
    intro:
      'Platform admin view of all organizations: Owner, members, status, plan and when they were last active.',
    controls: [
      {
        name: 'Search',
        text: 'Find an organization by name or Owner email.',
      },
      {
        name: 'Status filter',
        text: 'Show active, trial, suspended or cancelled organizations.',
      },
      {
        name: 'Sort by',
        text: 'Sort by name, created, last active or members.',
      },
      {
        name: 'Organization table',
        text: 'Every organization with its Owner, member count, status, plan and last activity. Click one to open it.',
      },
    ],
    article: 'organizations-and-roles#suspension',
  },
  '/platform/orgs/:id': {
    title: 'Organization detail',
    intro: 'View and manage one organization: its Owner, plan, limits, features and status.',
    controls: [
      {
        name: 'Suspend, Reactivate and Cancel',
        text: "Change the organization's status. Each asks for a reason and is recorded in the audit log.",
      },
      {
        name: 'Overview',
        text: 'Owner, member count, shifts in the last 30 days, when it was created and last active, and whether two-factor login is required.',
      },
      {
        name: 'Transfer ownership',
        text: "Move ownership to one of the organization's Admins, with a mandatory reason.",
      },
      {
        name: 'Plan, limits and features',
        text: 'Set the limits (leave empty for unlimited), the licence expiry and which features are on, with a reason for the change.',
      },
      {
        name: 'Billing',
        text: 'Its subscription, card and invoices. Pause or Unpause the organization, or Assign Unlimited (no billing, no limits). Each asks for a reason and is audited.',
      },
      {
        name: 'Simulation',
        text: 'Switch simulation on for testing and demos (agents run on a simulated workstation, nothing is built or billed). Only an empty organization (no projects, even archived, and no active subscription) can be switched, and it cannot be switched off again, only deleted. Set its pace, load the demo scenario (it only adds what is missing, so it is safe to load again), or delete the whole simulation organization with all its data (you type its name to confirm).',
      },
      {
        name: 'Recent activity',
        text: 'The latest audit entries for this organization.',
      },
    ],
    article: 'organizations-and-roles#suspension',
  },
  '/platform/invitations': {
    title: 'Invitations',
    intro: 'Invite the Owner of a new organization and manage the invitations that are still open.',
    controls: [
      {
        name: 'Invite a new organization',
        text: "Enter the Owner's email and an organization name to send the invitation. Tick Simulation organization to create it as a sandbox for testing or demos.",
      },
      {
        name: 'All invitations',
        text: 'Every invitation with its status (pending, accepted or revoked) and when it expires.',
      },
      {
        name: 'Resend',
        text: 'Send a pending invitation again.',
      },
      {
        name: 'Revoke',
        text: 'Cancel a pending invitation before it is accepted.',
      },
    ],
    article: 'organizations-and-roles#platform-area',
  },
  '/platform/users': {
    title: 'Accounts',
    intro: 'Everyone with an account. An Owner is deactivated only after ownership has moved.',
    controls: [
      {
        name: 'Search',
        text: 'Find an account by name or email.',
      },
      {
        name: 'Account row',
        text: 'Name, email, number of organizations, last sign-in, and badges for platform admin, deactivated and 2FA on.',
      },
      {
        name: 'Reset 2FA',
        text: "Clear a person's two-factor login so they set it up again (recorded in the audit log).",
      },
      {
        name: 'Send reset link',
        text: 'Email the person a one-time link to choose a new password (valid for an hour). Shows when the last link was sent; recorded in the audit log.',
      },
      {
        name: 'Deactivate and Reactivate',
        text: 'Lock an account out, or let it sign in again.',
      },
    ],
    article: 'organizations-and-roles#platform-area',
  },
  '/platform/blog': {
    title: 'Blog',
    intro:
      'The Guildwise HQ blog: the Writer, the review queue, the kill switch, moderation, the weekly digest and social sharing.',
    controls: [
      {
        name: 'Writer',
        text: "The blog writer runs on the Guildwise server with the platform Anthropic key. Switch it on (off by default), choose 1 or 2 articles a day, edit the topics, pick the model and set the monthly cap (default $10). It shows this month's spend and each run, and Write one now writes an article straight away. It stops before the cap and while the blog is switched off.",
      },
      {
        name: 'Switch the blog off',
        text: 'The kill switch. The writer and API tools are refused when they create posts, and nothing is published, mailed or shared until you switch it on again.',
      },
      {
        name: 'Auto-publish starts on and Hold',
        text: 'Until the date you review every post. After it, a post without warnings publishes by itself once it has waited the hold (hours); posts already waiting on that date are released too, with the hold counted from the date.',
      },
      {
        name: 'Status chips',
        text: 'Filter the posts by In review, Drafts, Published, Rejected or Unpublished. The number is how many are waiting for you.',
      },
      {
        name: 'Post list',
        text: 'Each post with its status, warnings, who sent it and when. Click one to review it.',
      },
      {
        name: 'Weekly digest',
        text: 'Switch the Monday email on or off, send a test to yourself and see what each week did.',
      },
      {
        name: 'Social sharing',
        text: 'Connect the Facebook Page, the LinkedIn organization, X and Bluesky. A banner shows when a token needs replacing.',
      },
    ],
    article: 'blog-and-digest#platform-blog',
  },
  '/platform/blog/:id': {
    title: 'Blog post',
    intro: 'One post: edit it, see it as it will look, then approve or reject it.',
    controls: [
      {
        name: 'Approve and publish',
        text: 'Make the post public now. It then appears on the blog, in the feed and in Help.',
      },
      {
        name: 'Reject',
        text: 'Send it back with a reason. The reason stays with the post; an outside tool that sent it can read it and resubmit.',
      },
      {
        name: 'Unpublish',
        text: 'Take a published post down (its address then says it was removed). Social posts that were already made stay.',
      },
      {
        name: 'Edit and Preview',
        text: 'Change the text, tags, cover, sources, search texts and the social captions, with the result next to it.',
      },
      {
        name: 'Social shares',
        text: 'Whether the post reached each network, with a link, and a button to try again for failed ones.',
      },
    ],
    article: 'blog-and-digest#platform-blog',
  },
  '/platform/api-keys': {
    title: 'API keys',
    intro:
      'Keys that let an outside tool post to the blog through the blog API. The built-in blog writer does not need one.',
    controls: [
      {
        name: 'New key',
        text: 'Give it a name and the scopes it needs. You can add an expiry date and limit it to certain IP addresses. The key is shown once.',
      },
      {
        name: 'Key list',
        text: 'Each key with its scopes, when it was last used, how much it did in the last 24 hours and its state.',
      },
      {
        name: 'Revoke',
        text: 'Stops a key on its next request. It cannot be undone.',
      },
      {
        name: 'Recent requests',
        text: 'The audit trail of what the keys did.',
      },
    ],
    article: 'blog-and-digest#platform-blog',
  },
  '/platform/runners': {
    title: 'Runners',
    intro:
      'The runner version this server offers, and the switch that pauses automatic runner updates. Runners check once a day and update themselves when a newer version is offered.',
    controls: [
      {
        name: 'Version offered to runners',
        text: 'The newest runner release published on this server.',
      },
      {
        name: 'Pause automatic updates',
        text: 'Runners stay on the version they have, and a runner that already downloaded an update drops it before restarting. Use it when a release turns out to be bad. The installer still works.',
      },
      {
        name: 'Resume automatic updates',
        text: 'Runners pick the current version up at their next daily check.',
      },
    ],
    article: 'workstations-and-installer#runner-updates',
  },
  '/platform/team': {
    title: 'Platform team',
    intro:
      "Which of your organizations and projects fixes Guildwise itself. Bugs the runners and the server report become cards in that project; its approvals and reports go to that organization's desk, not to you.",
    controls: [
      {
        name: 'Designate',
        text: 'Pick one existing organization and the id of one of its projects. The project keeps its decisions at project level. Clear removes the designation: bugs are still recorded but no cards are filed.',
      },
      {
        name: 'Pauses',
        text: 'Work paused for what a critical bug hits (a project and stage, or a workstation). Pauses end by themselves when the bug card is fixed, or with Resume. The platform project is never paused.',
      },
      {
        name: 'Safe mode pins',
        text: 'Pin all workstations to a runner version, an older one too, to roll back a bad release. Unpin follows the latest release again.',
      },
    ],
    article: 'workstations-and-installer#runner-updates',
  },
  '/platform-team': {
    title: 'Platform team',
    intro:
      'Bugs, pauses, safe mode, grants and the deploy audit trail of Guildwise itself. Members of the platform project read; the Owner and Admins of this organization act. Approvals are items on the Desk.',
    controls: [
      {
        name: 'Pauses',
        text: 'Open pauses and why they started. Resume ends one by hand; they also end when the bug card is fixed.',
      },
      {
        name: 'Bugs',
        text: 'One row per problem, with severity and how often it was seen. The card is in the platform project.',
      },
      {
        name: 'Deploy audit trail',
        text: 'Every deploy check and deploy: version, risk, who approved, and the rollback path.',
      },
    ],
    article: 'workstations-and-installer#runner-updates',
  },
  '/platform/inbound': {
    title: 'Inbound mail',
    intro:
      "Whether the mail provider that delivers organizations' e-mail is set up, and what has been arriving. Metadata only: no organization's mail is shown here.",
    controls: [
      {
        name: 'Provider',
        text: 'The provider, the receiving domain, whether the webhook secret is set, and the limits. Not ready means one of the three settings is missing; the steps are in docs/DEPLOY.md, Inbound e-mail.',
      },
      {
        name: 'Last 24 hours',
        text: 'Messages accepted and skipped (with the reasons), mail sent to an address nobody owns, and webhook calls refused for bad credentials.',
      },
    ],
    article: 'automations-and-integrations#email-inbox',
  },
  '/platform/audit': {
    title: 'Audit log',
    intro: 'Every platform administrator action and every licensing action by the system. Kept forever.',
    controls: [
      {
        name: 'Filter by action',
        text: 'Type an action name, for example OrgSuspended, to show only those entries.',
      },
      {
        name: 'Entries',
        text: 'Each entry with its summary, the time, who did it, the action, the organization and the address it came from.',
      },
      {
        name: 'Older entries',
        text: 'Load the next page of older entries.',
      },
    ],
    article: 'organizations-and-roles#platform-area',
  },
  '/platform/help': {
    title: 'Help',
    intro:
      'The same articles and glossary as in the app, plus the tour. Contact us is only for organization members.',
    controls: [
      {
        name: 'Articles',
        text: 'The help articles. Search them, or open one.',
      },
      {
        name: 'Glossary',
        text: 'Definitions of the terms used in the app.',
      },
      {
        name: 'Tour replay',
        text: 'Watch the platform administrator tour again.',
      },
      {
        name: 'This panel',
        text: 'Help text for every page you visit. Click the ? button in the top bar to see it again.',
      },
    ],
    article: 'organizations-and-roles#platform-area',
  },
};
