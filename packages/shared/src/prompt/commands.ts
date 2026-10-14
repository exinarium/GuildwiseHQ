import type { ShiftBrief } from '../protocol/runner.ts';

type BriefOutcome = ShiftBrief['shift']['outcomes'][number];

/** The exact `aom` command line an agent runs to report `outcome` (docs/ARCHITECTURE.md section 13.4). */
export function commandForOutcome(outcome: BriefOutcome): string {
  switch (outcome.id) {
    case 'handoff':
      if (outcome.data === 'investigation')
        return 'aom design --report <report path> --summary "<3-6 lines for the builder: what to build and where>"';
      if (outcome.data === 'candidates')
        return 'aom handoff --note "<what you searched>" --data-file <candidates.json>   # { "items": [ { kind, url, title, source, publishedAt, summary } ] }';
      return 'aom handoff --note "<what you did, what to look at, anything risky>"';
    case 'report':
      if (outcome.data === 'investigation')
        return 'aom investigate --report <report path> --summary "<what you found and recommend>"';
      return `aom outcome report --note "<summary>"`;
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
    case 'published':
      return 'aom publish --file <note.md> --title "<title>" --citations-file <citations.json>   # citations: [ { url, title } ] of pages you opened; no citations, no publication';
    case 'unsupported':
      return 'aom outcome unsupported --note "<each unsupported claim and why>"';
    case 'finalized':
      return 'aom finalize --note "<note>"   # runs the card\'s own completion action; never pass --action, only the manager changes it';
    case 'devops_done':
      return 'aom devops-done --summary "<what you did>" --command "<command you ran>"';
    case 'devops_approval':
      return 'aom devops-approval --action "<what needs approval>" --reason "<why>" --command "<command you would run>"';
    case 'phase_report':
      return 'aom phase report --summary-file <report.md> [--outstanding "<item>"]...';
    case 'phase_ready':
      return 'aom phase ready --note "<every follow-up is briefed>"';
    case 'followup_done':
      return 'aom phase followup done <n> --summary "<what you did>" [--link <url>]...';
    case 'followup_failed':
      return 'aom phase followup fail <n> --summary "<why it could not be done>"';
    case 'triage_done':
      return 'aom report triage --file <decisions.json>   # { "decisions": [ { "itemId", "action": "pass|dismiss|merge", "note"?, "into"? } ] }';
    case 'notes_done':
      return 'aom report notes --file <notes.json>   # { "notes": [ { "itemId", "note", "related"? } ] }';
    case 'signal_report':
      return 'aom report signals --file <reports.json>   # { "reports": [ { "signalId", "summary" (markdown), "annotateItemId"? } ] }';
    case 'floor_report':
      return 'aom report floor --summary-file <report.md>';
    case 'scheduled_brief':
      return 'aom report brief --summary-file <report.md>';
    case 'batch_done':
      return 'aom batch done --note "<the cards you created and why this split>"';
    case 'batch_ask':
      return 'aom batch ask --text "<one precise question>" [--option "<answer a>"]... [--recommend <n>]';
    case 'batch_skip':
      return 'aom batch skip --note "<why this ticket needs no card>"';
    case 'batch_fail':
      return 'aom batch fail --note "<why this ticket cannot be turned into cards>"';
    case 'phase_results':
      return 'aom phase results --summary-file <report.md>';
    default:
      return `aom outcome ${outcome.id} --note "<summary>"${outcome.data !== 'none' ? ' --data-file <json>' : ''}`;
  }
}

export const QUESTION_COMMAND =
  'aom question --text "<question>" [--option "<answer a>"]... [--recommend <n>] --doing "<what you were doing>"';
