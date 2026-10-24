/**
 * A small, neutral sample pack in the generic conventions (original text written for the tests): `SKILL.md` folders are skills,
 * persona files are listed under `agents:` in `pack.yaml`, `playbooks/<key>/workflow.md` folders (with `steps/`) are playbooks, and
 * the manifest labels the playbooks a new discovery offers (`discovery`, `template:brief`, `template:prd`).
 */
export type Tree = Record<string, string>;

export const LICENSE =
  'MIT License\n\nCopyright (c) 2025 Example Maintainers\n\nPermission is hereby granted, free of charge...\n';

const frontmatter = (fields: Record<string, string>, body: string): string =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\n${body}\n`;

const persona = (name: string, description: string, body: string): string =>
  frontmatter({ name, description }, body);

const playbook = (key: string, description: string, body: string): string =>
  frontmatter({ name: key, description }, body);

const MANIFEST = `agents:
  - file: agents/analyst.md
    name: Mary
    title: Business Analyst
    icon: "📊"
    voice: Short sentences, concrete examples.
    stance: Evidence first. Name the trade-off.
  - file: agents/pm.md
    name: John
    title: Product Manager
    icon: "📋"
  - file: agents/dev.md
    name: Amelia
    title: Senior Software Engineer
    icon: "💻"
playbooks:
  - dir: playbooks/brainstorming
    tags: [discovery]
  - dir: playbooks/advanced-elicitation
    tags: [discovery, stress_test]
  - dir: playbooks/product-brief
    tags: ["template:brief"]
  - dir: playbooks/prd
    tags: ["template:prd"]
`;

export function samplePackFixture(): Tree {
  return {
    LICENSE,
    'README.md': '# sample pack\n',
    'pack.yaml': MANIFEST,
    'agents/analyst.md': persona(
      'analyst',
      'Business analyst for tests. Use when the user asks to talk to Mary',
      'You are Mary, the Business Analyst. You keep notes and ask what the evidence is.',
    ),
    'agents/pm.md': persona(
      'pm',
      'Product manager for tests. Use when the user asks to talk to John',
      'You are John, the Product Manager. You cut scope.',
    ),
    'agents/dev.md': persona(
      'dev',
      'Engineer for tests. Use when the user asks to talk to Amelia',
      'You are Amelia, a senior engineer. You build the smallest thing that works.',
    ),
    'playbooks/brainstorming/workflow.md': playbook(
      'brainstorming',
      'Facilitate a brainstorming session using diverse creative techniques',
      '# Brainstorming\n\nYou coach a brainstorm. Offer `sample:advanced-elicitation` at any time. Pick techniques from assets/brain-methods.csv.',
    ),
    'playbooks/brainstorming/assets/brain-methods.csv':
      'category,technique_name,description\ncollaborative,Yes And,"Build on the last idea"\n',
    'playbooks/brainstorming/references/finalize.md': '# Finalize\n\nSummarise for the owner.\n',
    'playbooks/brainstorming/scripts/brain.py': 'print("hello")\n',
    'playbooks/advanced-elicitation/workflow.md': playbook(
      'advanced-elicitation',
      'Push a section further with a named reasoning method',
      '# Advanced elicitation\n\nPick a method from assets/methods.csv and apply it to the selected text.',
    ),
    'playbooks/advanced-elicitation/assets/methods.csv':
      'num,category,method_name,description\n1,advanced,Tree of Thoughts,"Explore paths"\n',
    'playbooks/product-brief/workflow.md': playbook(
      'product-brief',
      'Create or validate a product brief',
      '# Product brief\n\nCoach the brief.',
    ),
    'playbooks/product-brief/assets/brief-template.md': '# Brief\n\n## Problem\n\n',
    'playbooks/prd/workflow.md': playbook(
      'prd',
      'Create, update or validate a PRD',
      '# PRD\n\nFacilitate the PRD.',
    ),
    'playbooks/prd/assets/prd-template.md': '# PRD\n\n## Goals\n\n',
    'playbooks/prd/assets/prd-validation-checklist.md': '- [ ] Goals are measurable\n',
    'playbooks/create-epics-and-stories/workflow.md': playbook(
      'create-epics-and-stories',
      'Break a PRD into epics and stories',
      '# Epics\n\nSplit work.',
    ),
    'playbooks/create-epics-and-stories/steps/step-01-validate.md': '# Step 1\n',
    'playbooks/create-epics-and-stories/templates/epics-template.md': '# Epics\n',
    'skills/dev-story/SKILL.md': frontmatter(
      { name: 'dev-story', description: 'Implement a story' },
      '# Dev story\n\nImplement.',
    ),
    // never indexed: tests and vendored code
    'tests/ignored/SKILL.md': 'not a skill',
    'node_modules/x/SKILL.md': 'not a skill',
  };
}
