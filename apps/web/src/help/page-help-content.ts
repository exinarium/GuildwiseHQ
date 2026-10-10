import type { PageHelp } from './types.ts';

export const PAGE_HELP: Record<string, PageHelp> = {
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
        text: 'The BA report, the follow-up results and the conversation about this phase.',
      },
    ],
    article: 'phases#phase-done',
  },
  '/schedules': {
    title: 'Schedules',
    intro:
      'Automate work with a trigger and an action: at a time, when something happens, or when an issue gets a label.',
    controls: [
      {
        name: 'New schedule',
        text: 'Open the three-step wizard: When (the trigger), What (the action) and Details.',
      },
      {
        name: 'Schedule list',
        text: 'Your schedules grouped by project, with the whole organization first. Each shows its trigger, next run and last run.',
      },
      {
        name: 'Run now',
        text: 'Run a schedule once, straight away.',
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
        text: 'Change a schedule, switch it off and on, or remove it. Schedules for the whole organization are changed by the Owner and Admins only.',
      },
      {
        name: 'New secret',
        text: 'For webhooks: replace the signing secret. The new one is shown once.',
      },
    ],
    article: 'schedules-and-integrations#triggers',
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
        text: "For code work: which repository. How the work lands follows the project's setting; in expert mode you can also pick a completion action (pr, push_branch or merge).",
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
        text: 'Project name, how finished work lands (straight into main, or as a pull request), architectural globs (for repos) and E2E test globs. The working branch field appears in expert mode.',
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
        name: 'Phases and deploys',
        text: 'Create phases, set the default follow-ups and add deploy targets. For code projects.',
      },
      {
        name: 'Merging',
        text: 'Let large changes merge without your approval (project owner only, off by default).',
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
        name: 'Workflow editor',
        text: 'Design a workflow with its stages and where cards go on success and failure. Validation errors and a preview graph show as you edit.',
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
    ],
    article: 'budgets-and-costs#monthly-budgets',
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
        name: 'Pair workstation',
        text: 'If the wizard is not available, pair a workstation using a one-time code.',
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
  '/settings': {
    title: 'Settings',
    intro:
      'Your personal preferences: picture, expert mode for code changes, the weekly blog digest, time zone, two-factor security and how the BA reports to you.',
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
        text: "Set your time zone. The daily floor report follows the Owner's time zone.",
      },
      {
        name: 'Use this browser zone',
        text: 'Auto-detect and save your browser time zone. Suggested if it differs from your saved zone.',
      },
      {
        name: 'Route via BA',
        text: 'If on, items agents raise go to your BA first. Urgent blocking questions and approvals still reach you at once. Owner and Admins can change it; it applies to the whole organization.',
      },
      {
        name: 'Daily floor report at',
        text: 'The time of day the BA posts its floor report (default 08:00). Click Save time.',
      },
      {
        name: 'Weekly blog digest',
        text: 'One email on Monday mornings with the new blog articles. On by default for Owners, off for everyone else until you tick it.',
      },
    ],
    article: 'getting-started#the-tour',
    tips: [
      'Your picture, time zone and two-factor login are personal to your account. Routing through the BA and the report time apply to the whole organization.',
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
    title: 'Decision desk',
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
        text: 'A spoken tutorial of about three minutes in five steps, with captions (CC). Each step under the video jumps to that part.',
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
        text: 'Watch the guided tour again to remember key features.',
      },
    ],
    article: 'getting-started#page-help',
  },
  '/help/contact': {
    title: 'Contact us',
    intro:
      'Write to the support team. Your name, email and organization go with the message, and you can see the page context first.',
    controls: [
      {
        name: 'Subject',
        text: 'A brief description of your issue or question.',
      },
      {
        name: 'Category',
        text: 'Choose what it is about: Bug report, Question, Feature request or Billing.',
      },
      {
        name: 'Message',
        text: 'Full details about what you experienced and what you expected.',
      },
      {
        name: 'Screenshot (optional)',
        text: 'A screenshot of the page you were on is captured first; remove it or upload another PNG, JPEG or WebP image up to 2.5 MB.',
      },
      {
        name: 'What we send with your request',
        text: 'Opens the page, app version, browser, screen size, time zone and recent errors that go along. You can leave the errors out.',
      },
      {
        name: 'Send',
        text: 'Send your message. It then shows under My requests, and the answer arrives by email.',
      },
    ],
    article: 'writing-to-us#contact-us',
  },
  '/help/requests': {
    title: 'My requests',
    intro: 'All your support tickets and answers from the Guildwise HQ team. New replies appear as badges.',
    controls: [
      {
        name: 'Request list',
        text: 'All your support tickets with subject, category, status and whether there is a new reply.',
      },
      {
        name: 'New reply badge',
        text: "Shown on a request where the support team's reply is the last message and the request is not closed.",
      },
      {
        name: 'Click to read',
        text: 'Click any request to see the full conversation and support replies.',
      },
      {
        name: 'Contact us link',
        text: 'Jump to the Contact form if you need to send another message.',
      },
    ],
    article: 'writing-to-us#my-requests',
  },
  '/help/requests/:id': {
    title: 'Request thread',
    intro: 'One support ticket and the full conversation between you and the Guildwise HQ team.',
    controls: [
      {
        name: 'Your message',
        text: 'What you wrote to support, with the date you sent it.',
      },
      {
        name: 'Support reply',
        text: 'The response from the support team with guidance, updates or a solution.',
      },
      {
        name: 'Status badge',
        text: 'Open (waiting for support response), Answered (support has replied) or Closed (resolved).',
      },
      {
        name: 'Back to requests',
        text: 'Return to the list of all your support tickets.',
      },
    ],
    article: 'writing-to-us#my-requests',
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
        text: "Enter the Owner's email and an organization name to send the invitation.",
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
  '/platform/support': {
    title: 'Support',
    intro: 'Every Contact us request from every organization and from visitors.',
    controls: [
      {
        name: 'Support address',
        text: 'The mailbox that also receives every new request, Contact us message and follow-up.',
      },
      {
        name: 'Also email me about',
        text: 'Two optional switches, off until you turn them on: new organizations and sign-ups, and platform audit events.',
      },
      {
        name: 'Landing-page assistant',
        text: 'Turn the "Ask Guildwise" chat on the public landing page on or off, and see today\'s messages and spend against the daily budget.',
      },
      {
        name: 'Status chips',
        text: 'Filter by All, Open, Answered or Closed, with counts.',
      },
      {
        name: 'Search',
        text: 'Find a request by reference, subject, name, email or organization.',
      },
      {
        name: 'Type filter',
        text: 'Filter by Bug report, Question, Feature request or Billing.',
      },
      {
        name: 'Request list',
        text: 'Each request with who wrote, their organization, type, status and last message. Click one to open it.',
      },
    ],
    article: 'writing-to-us#my-requests',
  },
  '/platform/support/:id': {
    title: 'Support ticket',
    intro: 'One request with the whole conversation, the page it came from and what the app sent along.',
    controls: [
      {
        name: 'Request details',
        text: 'Who wrote it, their organization, when it was sent, the page, version, browser, recent browser errors and the screenshot.',
      },
      {
        name: 'Conversation',
        text: "The person's message and every reply in time order.",
      },
      {
        name: 'Reply',
        text: 'Write the answer. It is emailed to the person and shows under their My requests.',
      },
      {
        name: 'Send reply and Send and close',
        text: 'Send the reply and mark the request answered, or send it and close the request.',
      },
      {
        name: 'Mark open, answered or closed',
        text: 'Change the status without writing a reply.',
      },
    ],
    article: 'writing-to-us#my-requests',
  },
  '/platform/blog': {
    title: 'Blog',
    intro:
      'The Guildwise HQ blog: the review queue, the kill switch, moderation, the weekly digest and social sharing.',
    controls: [
      {
        name: 'Switch the blog off',
        text: 'The kill switch. Agents are refused when they create posts, and nothing is published, mailed or shared until you switch it on again.',
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
        text: 'Connect the Facebook Page and the LinkedIn organization. A banner shows when a token needs replacing.',
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
        text: 'Send it back with a reason. The writer agent sees the reason and can revise it.',
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
    intro: 'Keys that let an agent post to the blog through the agent API.',
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
  '/platform/billing': {
    title: 'Billing',
    intro:
      'The plan catalogue and the billing settings. Every change needs a reason and is written to the audit log.',
    controls: [
      {
        name: 'Plans',
        text: 'Edit each plan price (US dollars per month, VAT included) and its member, workstation and project limits. Empty means unlimited. Existing subscriptions keep their price. Unlimited is only assigned from an organization page.',
      },
      {
        name: 'Add-on prices',
        text: 'What a Business organization pays per extra member, workstation or project each month.',
      },
      {
        name: 'Payment provider',
        text: 'Which gateway is active (Paystack, PayFast or simulated) and whether it runs on test keys (sandbox) or live. The keys are set on the server, not here.',
      },
      {
        name: 'Invoice details',
        text: 'The company name, address and VAT number printed on every tax invoice. Placeholders until you enter the real ones.',
      },
      {
        name: 'VAT percent',
        text: 'The VAT contained in every price (15 for South Africa). It is taken out of the price, never added on top, and shown on every invoice.',
      },
      {
        name: 'Exchange rate override',
        text: 'Replaces the daily dollar-to-rand rate used when charging. Empty uses the daily rate.',
      },
    ],
    article: 'billing-and-plans#platform',
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
