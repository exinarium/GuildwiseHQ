import type { PublicationDto } from '@aom/shared';
import { safeHref } from '../lib/links.ts';
import { TranscriptExpander } from './Transcript.tsx';
import { Badge, Panel } from './ui.tsx';

/** The published note of a research card: where it lives in the vault, a preview and the citations it carries. */
export function PublicationPanel({ publication }: { publication: PublicationDto }) {
  return (
    <Panel>
      <div data-testid="publication">
        <h2 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
          Published note <Badge tone="green">fact-checked</Badge>
        </h2>
        <p className="text-sm font-medium" data-testid="publication-title">
          {publication.title}
        </p>
        <p className="mt-0.5 break-all font-mono text-xs text-subtle" data-testid="publication-path">
          {publication.vaultPath}
        </p>
        {publication.excerpt && (
          <blockquote
            className="mt-2 border-l-2 border-control pl-3 text-sm whitespace-pre-wrap text-muted"
            data-testid="publication-preview"
          >
            {publication.excerpt}
          </blockquote>
        )}
        <h3 className="mt-3 text-xs font-semibold text-muted">Citations ({publication.citations.length})</h3>
        <ol className="mt-1 list-decimal pl-5 text-sm" data-testid="publication-citations">
          {publication.citations.map((c) => (
            <li key={c.url}>
              {safeHref(c.url) ? (
                <a href={safeHref(c.url)} target="_blank" rel="noreferrer noopener" className="underline">
                  {c.title}
                </a>
              ) : (
                <span data-testid="unsafe-link">{c.title}</span>
              )}
              {c.transcriptPath && (
                <TranscriptExpander
                  projectId={publication.projectId}
                  url={c.url}
                  available
                  label="Transcript"
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
