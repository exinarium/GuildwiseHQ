import {
  ATTACHMENT_KINDS,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  type DocumentDto,
  type DocumentKind,
  type DocumentStatus,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
} from '@aom/shared';
import { Download, FileText, Paperclip, Search, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  documentFileUrl,
  useChangeDocumentStatus,
  useDocument,
  useDocuments,
  useDocumentTags,
  useSetDocumentTags,
  useUploadDocument,
} from '../api/queries/documents.ts';
import { useProjects } from '../api/queries/projects.ts';
import { DOC_STATUS_LABEL, DocumentBody } from '../components/discovery/DraftPanel.tsx';
import { TagInput } from '../components/TagInput.tsx';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorBox,
  FilterChip,
  inputCls,
  ListSkeleton,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextInput,
} from '../components/ui.tsx';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { ageLabel } from '../lib/time.ts';

const KIND_LABEL: Record<DocumentKind, string> = {
  brief: 'Product brief',
  prd: 'PRD',
  minutes: 'Minutes',
  session_log: 'Session log',
  file: 'Uploaded file',
};
const STATUS_TONE = {
  draft: 'neutral',
  in_review: 'warning',
  approved: 'success',
  handed_off: 'brand',
  archived: 'neutral',
} as const;

const ACCEPT = Object.keys(ATTACHMENT_KINDS)
  .map((e) => `.${e}`)
  .join(',');

/** Tag badges of a row: the first three, then "+n". */
function TagBadges({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="document-tags">
      {tags.slice(0, 3).map((t) => (
        <Badge key={t} tone="brand">
          {t}
        </Badge>
      ))}
      {tags.length > 3 && <span>+{tags.length - 3}</span>}
    </span>
  );
}

/** Upload a file as a document: where it goes, a title, and tags. Errors stay in the dialog. */
function UploadDialog({
  open,
  onOpenChange,
  tagSuggestions,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tagSuggestions: string[];
}) {
  const upload = useUploadDocument();
  const projects = useProjects();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const reset = () => {
    setFile(null);
    setTitle('');
    setProjectId('');
    setTags([]);
    setProblem(null);
    upload.reset();
  };
  const pick = (f: File | null) => {
    setFile(f);
    setProblem(
      f && f.size > MAX_ATTACHMENT_BYTES
        ? `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`
        : null,
    );
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || problem) return;
    try {
      await upload.mutateAsync({
        file,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(projectId ? { projectId } : {}),
        tags,
      });
      reset();
      onOpenChange(false);
    } catch {
      // shown below from `upload.error`
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Upload a document"
      description="The file is saved with your documents and copied to your vault."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="upload-document-form"
            loading={upload.isPending}
            disabled={!file || !!problem}
          >
            Upload
          </Button>
        </>
      }
    >
      <form id="upload-document-form" onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fileId} className="text-sm font-medium text-fg">
            File
          </label>
          <input
            id={fileId}
            type="file"
            accept={ACCEPT}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className={`${inputCls} file:mr-3 file:rounded-control file:border-0 file:bg-sunken file:px-3 file:py-1.5`}
          />
          {file && <p className="text-xs text-subtle">{formatBytes(file.size)}</p>}
          {problem && (
            <p role="alert" className="text-sm font-medium text-danger">
              {problem}
            </p>
          )}
        </div>
        <TextInput
          label="Title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          enterKeyHint="next"
        />
        <Select label="Where" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">The organization</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <TagInput tags={tags} onChange={setTags} suggestions={tagSuggestions} />
        <ErrorBox error={upload.error} />
      </form>
    </Dialog>
  );
}

/** Briefs, PRDs, minutes, session logs and uploaded files of the organization. */
export function DocumentsList() {
  const [kind, setKind] = useState<DocumentKind | null>(null);
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const canManage = useCanManageOrg();
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const docs = useDocuments({
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
    ...(tags.length ? { tags } : {}),
  });
  const tagList = useDocumentTags();
  const known = (tagList.data ?? []).map((t) => t.tag);
  const shownTags = [...new Set([...tags, ...known])];
  const filtered = kind !== null || status !== null || q !== '' || tags.length > 0;
  const clear = () => {
    setKind(null);
    setStatus(null);
    setTags([]);
    setSearch('');
    setQ('');
  };
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Documents"
        sub="Briefs and PRDs from your discovery sessions, and files you upload. Approved ones are copied to your vault."
        actions={
          canManage ? (
            <Button onClick={() => setUploading(true)}>
              <Upload aria-hidden="true" className="size-4" />
              Upload
            </Button>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-col gap-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
          />
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            aria-label="Search documents"
            placeholder="Search title, file name or text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${inputCls} pl-9`}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterChip pressed={kind === null} onClick={() => setKind(null)}>
            All kinds
          </FilterChip>
          {DOCUMENT_KINDS.map((k) => (
            <FilterChip key={k} pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
              {KIND_LABEL[k]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterChip pressed={status === null} onClick={() => setStatus(null)}>
            Any status
          </FilterChip>
          {DOCUMENT_STATUSES.map((st) => (
            <FilterChip key={st} pressed={status === st} onClick={() => setStatus(status === st ? null : st)}>
              {DOC_STATUS_LABEL[st]}
            </FilterChip>
          ))}
        </div>
        {shownTags.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
            {shownTags.map((t) => (
              <FilterChip
                key={t}
                pressed={tags.includes(t)}
                onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}
              >
                #{t}
              </FilterChip>
            ))}
          </div>
        )}
        {filtered && (
          <div>
            <Button variant="link" onClick={clear}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
      {docs.isPending && <ListSkeleton rows={3} />}
      <ErrorBox error={docs.error} onRetry={() => void docs.refetch()} />
      {docs.data && docs.data.length === 0 && !filtered && (
        <EmptyState
          icon={FileText}
          tone="neutral"
          title="No documents yet"
          description="A discovery session writes a brief or a PRD here, or upload a file."
        />
      )}
      {docs.data && docs.data.length === 0 && filtered && (
        <EmptyState
          icon={Search}
          tone="neutral"
          title="No documents match"
          description="Try other words or tags."
          action={<Button onClick={clear}>Clear filters</Button>}
        />
      )}
      {docs.data && docs.data.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Documents">
          {docs.data.map((d) => (
            <li key={d.id}>
              <Link
                to={`/documents/${d.id}`}
                data-testid="document-row"
                className="flex min-h-14 flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3 hover:border-control sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-fg">{d.title}</span>
                  {d.file && (
                    <span className="flex items-center gap-1 truncate text-xs text-muted">
                      <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                      {d.file.name}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <TagBadges tags={d.tags ?? []} />
                  <Badge>{KIND_LABEL[d.kind]}</Badge>
                  <Badge tone={STATUS_TONE[d.status]}>{DOC_STATUS_LABEL[d.status]}</Badge>
                  <span className="tnum">v{d.currentVersion}</span>
                  <span>{ageLabel(d.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <UploadDialog open={uploading} onOpenChange={setUploading} tagSuggestions={known} />
    </div>
  );
}

/** The tags of a document, with an editor for managers. */
function DocumentTags({ d, canManage }: { d: DocumentDto; canManage: boolean }) {
  const setTags = useSetDocumentTags(d.id);
  const all = useDocumentTags();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const tags = d.tags ?? [];
  if (!editing)
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="document-tags">
        {tags.length === 0 && <span className="text-sm text-muted">No tags</span>}
        {tags.map((t) => (
          <Badge key={t} tone="brand">
            {t}
          </Badge>
        ))}
        {canManage && (
          <Button
            variant="link"
            onClick={() => {
              setDraft(tags);
              setEditing(true);
            }}
          >
            Edit tags
          </Button>
        )}
      </div>
    );
  return (
    <div className="mt-3 flex flex-col gap-2">
      <TagInput
        tags={draft}
        onChange={setDraft}
        suggestions={(all.data ?? []).map((t) => t.tag)}
        disabled={setTags.isPending}
      />
      <ErrorBox error={setTags.error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={setTags.isPending}
          onClick={async () => {
            try {
              await setTags.mutateAsync(draft);
              setEditing(false);
            } catch {
              // shown above
            }
          }}
        >
          Save tags
        </Button>
        <Button
          onClick={() => {
            setTags.reset();
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The original file of an uploaded document: its facts, a download link and a preview for images. */
function FilePanel({ d }: { d: DocumentDto }) {
  if (!d.file) return null;
  return (
    <Panel>
      <div className="flex flex-col gap-3" data-testid="document-file">
        <div className="flex flex-wrap items-center gap-3">
          <Paperclip aria-hidden="true" className="size-4 text-muted" />
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{d.file.name}</span>
          <span className="text-sm text-muted">
            {formatBytes(d.file.size)} · {d.file.contentType}
          </span>
          <a
            href={documentFileUrl(d.id, true)}
            className="inline-flex min-h-11 items-center gap-2 text-brand-text hover:underline"
          >
            <Download aria-hidden="true" className="size-4" />
            Download
          </a>
        </div>
        {d.file.image && (
          <img
            src={documentFileUrl(d.id)}
            alt={d.file.name}
            className="max-h-96 max-w-full self-start rounded-control border border-line object-contain"
          />
        )}
      </div>
    </Panel>
  );
}

/** One document: its text as markdown, its versions, its status and the sessions it came from. */
export function DocumentView() {
  const { id = '' } = useParams();
  const doc = useDocument(id);
  const status = useChangeDocumentStatus(id);
  const canManage = useCanManageOrg();
  if (doc.isPending) return <PageSkeleton label="Loading the document" panels={1} />;
  if (!doc.data)
    return (
      <EmptyState
        icon={FileText}
        tone="neutral"
        title="Document not found"
        description="It may have been removed, or you may not have access to its project."
      />
    );
  const d = doc.data;
  return (
    <div className="mx-auto max-w-3xl" data-testid="document-view">
      <PageHeader
        title={d.title}
        back={{ to: '/documents', label: 'All documents' }}
        sub={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{KIND_LABEL[d.kind]}</Badge>
            <Badge tone={STATUS_TONE[d.status]} data-testid="document-status">
              {DOC_STATUS_LABEL[d.status]}
            </Badge>
            <span className="tnum">version {d.currentVersion}</span>
            {d.vaultPath && d.publishedVersion !== null && <span>Copied to the vault as {d.vaultPath}</span>}
          </span>
        }
        actions={
          canManage ? (
            <>
              {d.status === 'draft' && (
                <Button onClick={() => status.mutate({ status: 'in_review' })} loading={status.isPending}>
                  Send for review
                </Button>
              )}
              {(d.status === 'draft' || d.status === 'in_review') && (
                <Button
                  variant="primary"
                  loading={status.isPending}
                  onClick={async () => {
                    if (d.status === 'draft') await status.mutateAsync({ status: 'in_review' });
                    await status.mutateAsync({ status: 'approved' });
                  }}
                >
                  Approve
                </Button>
              )}
              {(d.status === 'approved' || d.status === 'archived') && (
                <Button onClick={() => status.mutate({ status: 'draft' })} loading={status.isPending}>
                  Reopen
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <ErrorBox error={status.error} />
      <DocumentTags d={d} canManage={canManage} />
      {d.file && (
        <div className="mt-3">
          <FilePanel d={d} />
        </div>
      )}
      <div className="mt-3">
        <Panel>
          <DocumentBody id={id} />
        </Panel>
      </div>
      {d.sourceThreadIds.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          From{' '}
          {d.sourceThreadIds.map((t, i) => (
            <span key={t}>
              {i > 0 && ', '}
              <Link to={`/discovery/${t}`} className="text-brand-text hover:underline">
                a discovery session
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
