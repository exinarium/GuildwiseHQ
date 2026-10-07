import type { PageHelp } from './types.ts';

export const PAGE_HELP: Record<string, PageHelp> = {
  '/p/:projectKey/board': {
    title: 'Board',
    intro:
      'The project board shows all cards in stages of work. Move cards to report progress, and click any card for details.',
    controls: [
      {
        name: 'Search cards',
        text: 'Find a card by title, reference or content. Escape clears the search.',
      },
      {
        name: 'Blocked filter',
        text: 'Show only cards waiting on an answer you gave at the desk. Useful when you have decisions pending.',
      },
      {
        name: 'Rework filter',
        text: 'Show only cards sent back for fixes after review or test. Use this to track failed submissions.',
      },
      {
        name: 'Unassigned filter',
        text: 'Show only cards no agent has claimed yet. Use this to find work ready for pickup.',
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
        name: 'Regression dialog',
        text: 'A one-click approval to promote a card from test to release. Shown only on projects with a test stage.',
      },
      {
        name: 'Convert to project',
        text: 'Turn a research interest into a full code project with repositories and agents. Only available for eligible research projects.',
      },
      {
        name: 'Settings',
        text: 'Open project settings to change its name, working branch, repositories, budget and more.',
      },
      {
        name: 'New card',
        text: 'Create a new card to bring in work, describe a task or propose an idea.',
      },
    ],
    article: 'board-and-cards#reading-the-board',
    tips: ['Press n to create a card', 'Press b to go to the board'],
  },
  '/p/:projectKey/research': {
    title: 'Research',
    intro:
      'Research is in-progress scanning and discovery for an interest. See the scan results and refined set.',
    controls: [
      {
        name: 'Research content',
        text: 'Results from the scan, organized to show progress and findings.',
      },
    ],
    article: 'projects#creating-a-project',
  },
  '/p/:projectKey/phases/:number': {
    title: 'Phase',
    intro: 'A phase groups related work together. See all cards in this phase, their status and progress.',
    controls: [
      {
        name: 'Phase details',
        text: 'Cards and progress specific to this milestone or delivery phase.',
      },
    ],
    article: 'phases#phase-done',
  },
  '/schedules': {
    title: 'Schedules',
    intro: 'Automate workflows with triggers and actions. When an event happens, the action runs.',
    controls: [
      {
        name: 'Schedule list',
        text: 'All your triggers and actions that run on a schedule or when events occur.',
      },
      {
        name: 'Add schedule',
        text: 'Create a new trigger-action pair to automate work in your projects.',
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
        text: 'Summary of the interest: what it scans, its status, last scan time and recent stats.',
      },
      {
        name: 'Run log tab',
        text: 'History of all scans with results, errors or skips. Click a run to see what it found.',
      },
      {
        name: 'Digest tab',
        text: 'Items waiting to be delivered, and a record of what was already sent and how you rated it.',
      },
      {
        name: 'Settings tab',
        text: 'Change the scan schedule, delivery times, and vault where results are stored.',
      },
      {
        name: 'Taste tab',
        text: 'Rules to filter or prioritize results. Agents learn from your ratings and suggest new rules here.',
      },
      {
        name: 'Run scan',
        text: 'Start a scan immediately instead of waiting for the schedule. Results are added to the digest.',
      },
      {
        name: 'Research this',
        text: 'Open a focused research interface for this interest, or research a different interest on the same topic.',
      },
      {
        name: 'Deliver now',
        text: 'Send held-back items to the vault now. Use this when you are ready to accept more results.',
      },
      {
        name: 'Archive',
        text: 'Stop scanning and hide the interest. Archived interests can be restored.',
      },
    ],
    article: 'interests#run-and-delivery',
  },
  '/cards/new': {
    title: 'New card',
    intro: 'Create a new card to describe work, propose an idea or onboard a ticket from outside.',
    controls: [
      {
        name: 'Project',
        text: 'Choose which project the card belongs to.',
      },
      {
        name: 'Card type',
        text: 'Select the type of work: feature, bug, chore or other types defined in your roles.',
      },
      {
        name: 'Title and description',
        text: 'The card title and any details about what needs to be done.',
      },
      {
        name: 'Priority',
        text: 'Urgent, high, normal or low. Agents use this to order their work.',
      },
      {
        name: 'Custom fields',
        text: 'Extra fields specific to your workflow, such as time estimate or component.',
      },
      {
        name: 'External ref (optional)',
        text: 'A link to a ticket in Jira, GitHub or another system, so agents can track the source.',
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
        text: 'Draft, queued, in progress, blocked, waiting, done or cancelled. Only you can move the card between stages.',
      },
      {
        name: 'Card type badge',
        text: 'Feature, bug, chore or other types defined in your workflow.',
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
        text: 'The stages the card passes through. Click to see where the card is in its workflow.',
      },
      {
        name: 'Specify button',
        text: 'Mark the card as ready to work. Available when the card is a draft with all required fields filled.',
      },
      {
        name: 'Edit button',
        text: 'Change the card title, description, priority or custom fields.',
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
        text: 'Release (let another agent claim it), Re-home (reset workstation and branch), or Cancel the card.',
      },
      {
        name: 'What to build panel',
        text: 'Specification fields from the workflow: task, component, time estimate and other custom fields.',
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
        text: 'Stage, risk tier, completion action, priority, phase and decision policy all in one place.',
      },
      {
        name: 'Risk tier',
        text: 'How much code risk a change carries (small, medium, large). Set it or let the system calculate it.',
      },
      {
        name: 'Who answers its questions',
        text: 'Choose whether only the card owner or any project manager can answer questions from agents.',
      },
      {
        name: 'Decision policy',
        text: 'Control whether only the card owner or any project manager can answer blocking questions.',
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
        text: 'Create a code delivery, research or feed project. Available to owners and admins.',
      },
      {
        name: 'Active tab',
        text: 'Projects currently running. Most work happens here.',
      },
      {
        name: 'Archived tab',
        text: 'Projects that have finished or been paused. You can restore any of them.',
      },
      {
        name: 'Department filter',
        text: 'Show projects in a specific department. Leave empty to see all departments.',
      },
      {
        name: 'Project card',
        text: 'Shows the project name, key, type, department, domain and your role. Click to open its board.',
      },
      {
        name: 'Settings link',
        text: 'Open project settings to change its configuration.',
      },
    ],
    article: 'projects#creating-a-project',
    tips: ['Press p to go to projects'],
  },
  '/projects/:id/settings': {
    title: 'Project settings',
    intro: 'Configure a project: its name, repositories, budget, team, workflow stages and archive status.',
    controls: [
      {
        name: 'Basics tab',
        text: 'Project name, working branch, architectural globs (for repos) and E2E test globs.',
      },
      {
        name: 'Stage tab',
        text: 'The workflow stages cards pass through. Configure stage names and properties.',
      },
      {
        name: 'Repos tab',
        text: 'Add or remove repositories. Only for code delivery projects.',
      },
      {
        name: 'Phases and deploys tab',
        text: 'Break work into phases, set follow-up defaults and configure deploy targets. For code projects.',
      },
      {
        name: 'Merging tab',
        text: 'Set merge policies for pull requests and configure approval workflows.',
      },
      {
        name: 'Budget tab',
        text: 'Set a monthly budget for agent usage costs. The desk will pause work if overspent.',
      },
      {
        name: 'Team tab',
        text: 'Invite or remove members, and set roles. Owners manage everything; members manage cards.',
      },
      {
        name: 'Archive tab',
        text: 'Archive or permanently delete the project. Archiving is reversible; deletion is not.',
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
        text: 'Create a new agent for a role. Set seniority, model and which projects it works on.',
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
        text: 'A list of role version changes proposed by the BA. One-click to apply changes to agents in that role.',
      },
      {
        name: 'Recommendations',
        text: 'Suggestions for agent changes: hire, fire, promote or retrain. With evidence and one-click apply.',
      },
      {
        name: 'Agent card',
        text: 'Name, avatar, role, model, status, hiring manager and performance stats. Click to see details.',
      },
      {
        name: 'Work quality panel',
        text: 'Detailed quality metrics for builder agents: score, bounce rate and test failure rate.',
      },
      {
        name: 'Change model',
        text: 'Switch the agent to a different AI model.',
      },
      {
        name: 'Change role',
        text: 'Promote or retrain the agent to a different role.',
      },
      {
        name: 'Fire agent',
        text: 'Remove the agent. Active claims are released and work goes back in the queue.',
      },
      {
        name: 'Rehome agent',
        text: 'Move the agent to a different workstation or reset it to use any available workstation.',
      },
      {
        name: 'Reset agent',
        text: 'Clear the agent cache and restart. Use this if the agent is stuck or behaving oddly.',
      },
      {
        name: 'Reroll face',
        text: 'Give the agent a new avatar from the pool of generated faces.',
      },
      {
        name: 'Retired section',
        text: 'Agents who have been fired. Kept for reference; they no longer work.',
      },
    ],
    article: 'agents#hiring',
    tips: ['Press a to go to agents', 'You can link to a specific agent with #<agent-id>'],
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
        text: 'Create a new agent for a role. Set seniority, model and which projects it works on.',
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
        text: 'A list of role version changes proposed by the BA. One-click to apply changes to agents in that role.',
      },
      {
        name: 'Recommendations',
        text: 'Suggestions for agent changes: hire, fire, promote or retrain. With evidence and one-click apply.',
      },
      {
        name: 'Agent card',
        text: 'Name, avatar, role, model, status, hiring manager and performance stats. Click to see details.',
      },
      {
        name: 'Work quality panel',
        text: 'Detailed quality metrics for builder agents: score, bounce rate and test failure rate.',
      },
      {
        name: 'Change model',
        text: 'Switch the agent to a different AI model.',
      },
      {
        name: 'Change role',
        text: 'Promote or retrain the agent to a different role.',
      },
      {
        name: 'Fire agent',
        text: 'Remove the agent. Active claims are released and work goes back in the queue.',
      },
      {
        name: 'Rehome agent',
        text: 'Move the agent to a different workstation or reset it to use any available workstation.',
      },
      {
        name: 'Reset agent',
        text: 'Clear the agent cache and restart. Use this if the agent is stuck or behaving oddly.',
      },
      {
        name: 'Reroll face',
        text: 'Give the agent a new avatar from the pool of generated faces.',
      },
      {
        name: 'Retired section',
        text: 'Agents who have been fired. Kept for reference; they no longer work.',
      },
    ],
    article: 'agents#hiring',
    tips: ['Press a to go to agents', 'You can link to a specific agent with #<agent-id>'],
  },
  '/metrics': {
    title: 'Metrics',
    intro:
      'Dashboard of team performance: cards finalized, time blocked on you, bounce rate, quality and throughput.',
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
        text: 'How many cards your team completed and average per day. The foundation of team velocity.',
      },
      {
        name: 'Time blocked on you',
        text: 'Total time cards waited on desk answers, average per card and how many cards were held up.',
      },
      {
        name: 'Bounce rate',
        text: 'For each builder, the rate of cards sent back for review or test fixes. Lower is better.',
      },
      {
        name: 'Quality metrics',
        text: 'Test failure rate, bug density and rework rounds. Trends reveal quality issues early.',
      },
      {
        name: 'Queue depth',
        text: 'How many cards are waiting to be claimed. A queue means agents are at capacity.',
      },
      {
        name: 'Velocity chart',
        text: 'Cards completed per day, showing consistency and capacity trends.',
      },
    ],
    article: 'ba-reporter#floor-report',
  },
  '/org': {
    title: 'Organization',
    intro:
      'Design your organization: define roles and their capabilities, create custom workflows, set up departments and chat with the BA.',
    controls: [
      {
        name: 'Organization selector',
        text: 'If you manage a shared project, switch between your organization and the owner organization (read-only).',
      },
      {
        name: 'Roles tab',
        text: 'All roles available to agents: their seniority levels, responsibilities and capabilities.',
      },
      {
        name: 'Workflows tab',
        text: 'Custom workflows that agents follow. Each stage can define what agents do and what the BA checks.',
      },
      {
        name: 'Departments tab',
        text: 'Groups of agents and projects. Use departments to organize large teams.',
      },
      {
        name: 'Design with the BA tab',
        text: 'Chat with the BA about your organization, roles and workflows. The BA suggests improvements.',
      },
      {
        name: 'Role editor',
        text: 'Define a new role or edit an existing one. Set seniority levels and what they are responsible for.',
      },
      {
        name: 'Workflow editor',
        text: 'Design a custom workflow with stages and transitions. See validation errors and a preview graph.',
      },
      {
        name: 'Workflow graph',
        text: 'Visual preview of a workflow showing all stages and how cards flow through them.',
      },
      {
        name: 'Status badges',
        text: 'Active (in use), Draft (being edited), Waiting for approval (ready to use), Rejected or Superseded.',
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
        text: 'A flat list of all agents with their role, workstation and status.',
      },
      {
        name: 'View toggle',
        text: 'Switch between chart and list. Charts work best on wide screens.',
      },
      {
        name: 'Project filter',
        text: 'Show only agents allowed on a specific project. Agents allowed on any project always appear.',
      },
      {
        name: 'Agent details',
        text: 'Click any agent to see their full profile, workstation, department and performance.',
      },
      {
        name: 'Workstation indicator',
        text: 'A dot showing workstation health. Green means connected, yellow or red means issues.',
      },
      {
        name: 'Department label',
        text: 'Which department the agent belongs to. Helps organize large teams.',
      },
    ],
    article: 'org-chart-and-design#org-chart',
  },
  '/costs': {
    title: 'Costs',
    intro: 'Track what your agents cost: spending by project, agent and model. Set budgets and export data.',
    controls: [
      {
        name: 'Month preset',
        text: 'Show costs for the current month.',
      },
      {
        name: 'Last 30 days preset',
        text: 'Show costs for any 30-day rolling window.',
      },
      {
        name: 'Last month preset',
        text: 'Show costs for the previous calendar month.',
      },
      {
        name: 'Custom range',
        text: 'Pick start and end dates to see costs for any period.',
      },
      {
        name: 'Project filter',
        text: 'Show costs for a specific project or all projects combined.',
      },
      {
        name: 'Currency settings',
        text: 'Set your currency code and exchange rate against USD for cost display.',
      },
      {
        name: 'Total spend',
        text: 'Sum of all costs for agents, models and API calls in the selected period.',
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
        name: 'Export to CSV',
        text: 'Download costs data for analysis in a spreadsheet or accounting system.',
      },
    ],
    article: 'budgets-and-costs#monthly-budgets',
  },
  '/workstations': {
    title: 'Workstations',
    intro:
      'Computers that run your agents. Add a workstation with the installer wizard, or pair one with a code.',
    controls: [
      {
        name: 'Add a workstation',
        text: 'Launch the setup wizard to install Guildwise HQ on a new machine and pair it with your account.',
      },
      {
        name: 'Pair workstation',
        text: 'If the wizard is not available, pair a workstation using a one-time code.',
      },
      {
        name: 'Workstation card',
        text: 'Name, status, connected runtimes (Python, Node, etc) and health checks. Click to expand details.',
      },
      {
        name: 'Connection dot',
        text: 'Green means the workstation is connected and ready. Yellow or red means connection issues.',
      },
      {
        name: 'Runtime warnings',
        text: 'Alerts if a runtime is unsandboxed or unavailable. Some runtimes need Guildwise tools to run safely.',
      },
      {
        name: 'Expand for details',
        text: 'See agent runs, health checks, logs and options to unlink or refresh the workstation.',
      },
      {
        name: 'Health checks',
        text: 'Tests to confirm the workstation is ready. Red checks need fixing before work can run.',
      },
      {
        name: 'Unlink workstation',
        text: 'Disconnect a workstation. Active agent shifts are ended and work is re-queued.',
      },
    ],
    article: 'workstations-and-installer#add-a-workstation',
  },
  '/settings': {
    title: 'Settings',
    intro:
      'Your personal preferences: picture, time zone, two-factor security and how the BA reports to you.',
    controls: [
      {
        name: 'Your picture',
        text: 'A cartoon face, photo or custom image that shows in the sidebar, account menu and on your desk answers.',
      },
      {
        name: 'Change picture',
        text: 'Upload a new image or pick from generated cartoon faces.',
      },
      {
        name: 'Two-factor security',
        text: 'Enable or disable two-factor authentication. Protects your account from unauthorized access.',
      },
      {
        name: 'Your time zone',
        text: 'Set your time zone so the daily floor report is posted at the right time on your clock.',
      },
      {
        name: 'Use this browser zone',
        text: 'Auto-detect and save your browser time zone. Suggested if it differs from your saved zone.',
      },
      {
        name: 'Route via BA',
        text: 'If on, agent-raised questions go to your BA first for context. Urgent items and approvals still reach you immediately.',
      },
      {
        name: 'Daily report time',
        text: 'Choose what hour the BA delivers its floor report to you each day.',
      },
    ],
    article: 'getting-started#the-tour',
    tips: ['Your settings are personal to your account, not shared with other team members'],
  },
  '/settings/vaults': {
    title: 'Vaults',
    intro:
      'Storage folders for interests, research and other results. Each vault maps to a folder on your disk.',
    controls: [
      {
        name: 'Vault list',
        text: 'All configured vaults showing path, domain and which interests use each.',
      },
      {
        name: 'Search vaults',
        text: 'Find a vault by path or name.',
      },
      {
        name: 'Add vault',
        text: 'Create a new vault by pointing to a folder on your disk or a cloud storage mount.',
      },
      {
        name: 'Edit vault',
        text: 'Change vault settings: path, label or permissions.',
      },
      {
        name: 'Delete vault',
        text: 'Remove a vault. Interests using it must be reassigned to another vault.',
      },
    ],
    article: 'ledger-and-vaults#vaults',
  },
  '/settings/org': {
    title: 'Organization',
    intro: 'Manage your organization: members, invitations, guests and subscription plan.',
    controls: [
      {
        name: 'General tab',
        text: 'Organization name, domain and two-factor requirement. Owners and admins can edit.',
      },
      {
        name: 'Members tab',
        text: 'Everyone in the organization, their role and their projects. Members and guests see read-only view.',
      },
      {
        name: 'Invitations tab',
        text: 'Pending member invites. Copy links to invite people, or resend invites. Owners and admins only.',
      },
      {
        name: 'Guests tab',
        text: 'Guest members with access to specific projects only. Manage guest status and permissions. Owners and admins only.',
      },
      {
        name: 'Plan & limits tab',
        text: 'Current subscription plan, member count, agent limit and usage. Owners and admins only.',
      },
      {
        name: 'Your role',
        text: 'Owner (complete control), Admin (manage everything except billing) or Member (manage your cards).',
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
        text: 'Show only approvals: code merges, feature releases or configuration changes.',
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
        text: 'Quickly add a standing order, decision or requirement that agents should know.',
      },
      {
        name: 'Intake',
        text: 'Start an intake to organize new work coming from outside, or invite suggestions from agents.',
      },
      {
        name: 'Chat',
        text: 'Ask the BA for context or discuss strategy without sending a formal question.',
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
        text: 'How many cards are blocked by this item. Click to jump to the desk item.',
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
        text: 'Choose whether your answer becomes a standing order, decision or requirement in the ledger.',
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
    tips: ['Press d to go to the desk', 'Items are grouped by priority to show what needs you most'],
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
        name: 'Contact us tab',
        text: 'A form to write to support. Your message includes your browser and current page for context.',
      },
      {
        name: 'My requests tab',
        text: 'All your support tickets and responses. Check here for answers from the support team.',
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
    intro: 'Write to the support team. Your message, browser details and current page context are included.',
    controls: [
      {
        name: 'Subject',
        text: 'A brief description of your issue or question.',
      },
      {
        name: 'Category',
        text: 'Choose the type of issue: a bug, a feature request, billing or general help.',
      },
      {
        name: 'Message',
        text: 'Full details about what you experienced and what you expected.',
      },
      {
        name: 'Capture page context',
        text: 'Include the current page, its state and your browser details. Helps support understand your situation.',
      },
      {
        name: 'Send',
        text: 'Submit your message. A confirmation will appear under My requests.',
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
        text: 'Shown if the support team has answered since you last read the request.',
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
      'A conversation with the BA. Discuss strategy, ask for context or brainstorm without a formal desk item.',
    controls: [
      {
        name: 'Message thread',
        text: 'Back-and-forth conversation. You can see the full history.',
      },
      {
        name: 'Send message',
        text: 'Type and send a message. The BA will respond.',
      },
    ],
    article: 'chat-with-agents',
  },
  '/intake': {
    title: 'New intake',
    intro:
      'Organize new work from outside or invite agent suggestions. Intake turns raw input into structured cards.',
    controls: [
      {
        name: 'Intake form',
        text: 'Describe work you want done: a feature, bug, research topic or anything else.',
      },
      {
        name: 'Project',
        text: 'Which project this work belongs to.',
      },
      {
        name: 'Intake items',
        text: 'List of items you are adding. Each becomes a separate card.',
      },
      {
        name: 'Submit intake',
        text: 'Turn the intake into cards. Cards start in draft status.',
      },
    ],
    article: 'intake-and-outbox#intake',
  },
  '/intake/:id': {
    title: 'Intake view',
    intro: 'Review an intake: its items, status and the cards created from it.',
    controls: [
      {
        name: 'Intake details',
        text: 'The intake source, items and created cards.',
      },
      {
        name: 'View cards',
        text: 'Jump to any card created from this intake.',
      },
    ],
    article: 'intake-and-outbox#intake',
  },
  '/platform': {
    title: 'Organizations',
    intro: 'Platform admin view of all organizations. See metadata, status, plan and member count.',
    controls: [
      {
        name: 'Search',
        text: 'Find an organization by name or owner email.',
      },
      {
        name: 'Status filter',
        text: 'Show active, trial, suspended or cancelled organizations.',
      },
      {
        name: 'Sort by',
        text: 'Sort by name, creation date, last active or member count.',
      },
      {
        name: 'Organization table',
        text: 'List of all organizations with owner, members, status and plan.',
      },
      {
        name: 'Click org name',
        text: 'View details of an organization and manage its status.',
      },
      {
        name: 'Two-factor badge',
        text: 'Shown if this organization requires two-factor authentication for all members.',
      },
    ],
    article: 'organizations-and-roles#suspension',
  },
  '/platform/orgs/:id': {
    title: 'Organization detail',
    intro: 'View and manage one organization: members, subscription, two-factor requirement and status.',
    controls: [
      {
        name: 'Organization info',
        text: 'Name, owner, plan and subscription status.',
      },
      {
        name: 'Members',
        text: 'List of all members, their roles and status.',
      },
      {
        name: 'Subscription management',
        text: 'Current plan, billing cycle and any overages or limits.',
      },
      {
        name: 'Two-factor requirement',
        text: 'Toggle to require or allow two-factor authentication.',
      },
      {
        name: 'Suspension',
        text: 'Suspend or unsuspend the organization. Suspended orgs cannot access Guildwise HQ.',
      },
    ],
    article: 'organizations-and-roles#suspension',
  },
  '/platform/invitations': {
    title: 'Invitations',
    intro: 'Invite new organizations to the platform or manage pending invitations.',
    controls: [
      {
        name: 'Pending invitations',
        text: 'Orgs invited but not yet activated.',
      },
      {
        name: 'Invite org',
        text: 'Send an invitation email to a new organization owner.',
      },
      {
        name: 'Resend invitation',
        text: 'Send the invitation again if the owner did not receive it.',
      },
      {
        name: 'Cancel invitation',
        text: 'Revoke an invitation before the org signs up.',
      },
    ],
    article: 'organizations-and-roles#members-and-invitations',
  },
  '/platform/users': {
    title: 'Users',
    intro: 'Platform admin view of all user accounts: active, suspended or invited.',
    controls: [
      {
        name: 'User search',
        text: 'Find a user by name or email.',
      },
      {
        name: 'User status',
        text: 'Active (can sign in), suspended (locked out) or invited (awaiting signup).',
      },
      {
        name: 'Manage user',
        text: 'Suspend, unsuspend or delete a user account.',
      },
      {
        name: 'Reset password',
        text: 'Send a password reset email to a user.',
      },
    ],
    article: 'organizations-and-roles#members-and-invitations',
  },
  '/platform/support': {
    title: 'Support',
    intro: 'List of all support tickets from users and organizations. Search and filter by status or kind.',
    controls: [
      {
        name: 'Ticket search',
        text: 'Find a support ticket by subject, reference or organization.',
      },
      {
        name: 'Status filter',
        text: 'Show open, answered or closed tickets.',
      },
      {
        name: 'Kind filter',
        text: 'Filter by issue type: bug, feature request, billing or general.',
      },
      {
        name: 'Ticket list',
        text: 'All tickets with subject, sender, status and creation date.',
      },
      {
        name: 'Click ticket',
        text: 'View the full ticket and add replies.',
      },
    ],
    article: 'writing-to-us#contact-us',
  },
  '/platform/support/:id': {
    title: 'Support ticket',
    intro: 'One support ticket with full conversation. Add replies and manage ticket status.',
    controls: [
      {
        name: 'Ticket header',
        text: 'Subject, sender organization and current status.',
      },
      {
        name: 'Conversation thread',
        text: 'User message and all support replies in time order.',
      },
      {
        name: 'Add reply',
        text: 'Type and send a response to the user.',
      },
      {
        name: 'Change status',
        text: 'Mark as answered, closed or reopen if needed.',
      },
      {
        name: 'Assign ticket',
        text: 'Assign to a support team member.',
      },
    ],
    article: 'writing-to-us#contact-us',
  },
  '/platform/audit': {
    title: 'Audit log',
    intro: 'A record of system events: signups, suspensions, feature changes and administrative actions.',
    controls: [
      {
        name: 'Event log',
        text: 'Chronological list of all platform events with timestamp, actor and description.',
      },
      {
        name: 'Filter by event type',
        text: 'Show signups, suspensions, role changes or other event categories.',
      },
      {
        name: 'Search events',
        text: 'Find events by organization name or user email.',
      },
      {
        name: 'Export log',
        text: 'Download the audit log for compliance or analysis.',
      },
    ],
    article: 'troubleshooting',
  },
  '/platform/help': {
    title: 'Help',
    intro:
      'Platform admin documentation with articles on managing organizations, users, subscriptions and support.',
    controls: [
      {
        name: 'Admin articles',
        text: 'Guides for platform administrators: managing organizations, invitations, billing and support.',
      },
      {
        name: 'Glossary',
        text: 'Definitions specific to platform administration.',
      },
      {
        name: 'Tour replay',
        text: 'Watch the admin tour again.',
      },
      {
        name: 'This panel',
        text: 'Help text for every page you visit. Click ? to see it again.',
      },
    ],
    article: 'install-troubleshooting',
  },
};
