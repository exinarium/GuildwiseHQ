import type { ShiftBrief } from '../protocol/runner.ts';

type BriefOutcome = ShiftBrief['shift']['outcomes'][number];

/** The exact `aom` command line an agent runs to report `outcome` (docs/ARCHITECTURE.md section 13.4). */
export function commandForOutcome(outcome: BriefOutcome): string {
  switch (outcome.id) {
    case 'handoff':
      if (outcome.data === 'candidates')
        return 'aom handoff --note "<what you searched>" --data-file <candidates.json>   # { "items": [ { kind, url, title, source, publishedAt, summary } ] }';
      return 'aom handoff --note "<what you did, what to look at, anything risky>"';
    case 'approve':
      return 'aom review approve --score <1-5> --note "<why this meets the card>"';
    case 'changes':
      return 'aom review changes --reason <reason>[,<reason>] --score <1-5> --criteria-missed "<criterion>" --note "<specific, actionable comments>"';
    case 'pass':
      return 'aom test pass --evidence "<what you ran and saw>" --command "<command you ran>"';
    case 'fail':
      return 'aom test fail --title "<bug title>" --note "<what failed and how to reproduce>" --evidence-file <path>';
    case 'digest':
      return 'aom digest --file <digest.json> --note "<what you picked and why>"   # { "items": [ ... ] }, empty when nothing qualifies';
    case 'devops_done':
      return 'aom devops-done --summary "<what you did>" --command "<command you ran>"';
    case 'devops_approval':
      return 'aom devops-approval --action "<what needs approval>" --reason "<why>" --command "<command you would run>"';
    default:
      return `aom outcome ${outcome.id} --note "<summary>"${outcome.data !== 'none' ? ' --data-file <json>' : ''}`;
  }
}

export const QUESTION_COMMAND =
  'aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"';
