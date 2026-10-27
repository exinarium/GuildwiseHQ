/** A Claude Code plugin marketplace laid out like `plugins/<p>/{agents,commands,skills}` (written for these tests). */
export const subagent = (name: string, description = `The ${name} subagent.`, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nYou are ${name}. Do the work well.\n`;
export const command = (description?: string) =>
  `${description ? `---\ndescription: ${description}\nargument-hint: [target]\nallowed-tools: Bash(git:*)\n---\n` : ''}# Do it\n\nRun the thing on $ARGUMENTS.\n`;
export const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n\nSteps.\n`;

export function smallMarketplace(): Record<string, string> {
  return {
    LICENSE: 'MIT License\n\nCopyright (c) 2025 Example Maintainers\n',
    'agents/root-helper.md': subagent(
      'root-helper',
      'A helper at the root.',
      'tools: Read, Grep\nmodel: sonnet\n',
    ),
    'plugins/backend/agents/reviewer.md': subagent('reviewer', 'Reviews backend code.'),
    'plugins/backend/agents/backend-architect.md': subagent('backend-architect', 'Designs services.'),
    'plugins/frontend/agents/reviewer.md': subagent('reviewer', 'Reviews UI code.'),
    'plugins/backend/commands/deploy.md': command('Deploy the service'),
    'plugins/frontend/commands/deploy.md': command(),
    'plugins/frontend/commands/lint.md': command('Lint the UI'),
    'commands/hello.md': command('Say hello'),
    'plugins/backend/skills/api-design/SKILL.md': skillMd('api-design'),
    // inside a skill folder: part of the skill, never a persona or a playbook
    'plugins/backend/skills/api-design/agents/helper.md': subagent('helper'),
    'plugins/backend/skills/api-design/commands/run.md': command('x'),
    // not subagents
    'plugins/backend/agents/README.md': '# Agents\n\nThese are the agents.\n',
    'plugins/backend/agents/notes.md': 'just some notes without frontmatter\n',
    // excluded folders
    'plugins/backend/tests/agents/fake.md': subagent('fake'),
    'docs/commands/doc.md': command('doc'),
    'node_modules/x/agents/vendored.md': subagent('vendored'),
    // read by the existing rules
    '.claude/agents/claude-one.md': subagent('claude-one'),
  };
}

/** About what github.com/wshobson/agents holds: 200 agents, 100 skills, 80 commands over 60 plugins. */
export function bigMarketplace(): Record<string, string> {
  const tree: Record<string, string> = { LICENSE: 'MIT License\n\nCopyright (c) 2025 Example\n' };
  for (let i = 0; i < 60; i++) {
    const p = `plugin-${i}`;
    for (let a = 0; a < 3; a++)
      tree[`plugins/${p}/agents/agent-${i}-${a}.md`] = subagent(`agent-${i}-${a}`, `Agent ${i} ${a}.`);
    if (i < 20) tree[`plugins/${p}/agents/agent-${i}-3.md`] = subagent(`agent-${i}-3`);
    if (i < 40)
      for (let s = 0; s < 3 && i * 3 + s < 100; s++) {
        const k = `skill-${i}-${s}`;
        tree[`plugins/${p}/skills/${k}/SKILL.md`] = skillMd(k);
        tree[`plugins/${p}/skills/${k}/references/a.md`] = 'x'.repeat(2000);
      }
    for (let c = 0; c < 2 && i * 2 + c < 80; c++)
      tree[`plugins/${p}/commands/cmd-${i}-${c}.md`] = command(`Command ${i} ${c}`);
    // a shared name in every plugin
    tree[`plugins/${p}/commands/status.md`] = command('Status');
  }
  return tree;
}
