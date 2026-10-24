import {
  BOARD_CAST_MAX,
  BOARD_CAST_MIN,
  BOARD_FORMAT_HINT,
  BOARD_FORMAT_LABEL,
  BOARD_FORMATS,
  BOARD_ROUND_CAP_DEFAULT,
  type BoardFormat,
  type BoardModels,
  type BoardRoom,
  type CastMember,
  type ModelChoice,
  participantSlug,
} from '@aom/shared';
import { Plus, Sparkles, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAgents } from '../../api/queries/agents.ts';
import {
  useBoard,
  useBoardRooms,
  useCreateBoard,
  usePersonas,
  useSaveBoardRoom,
  useStartBoard,
  useSuggestCast,
} from '../../api/queries/boardroom.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { fromChoice, ModelSelect, toChoice, unionExtras, unionProviders } from '../ModelSelect.tsx';
import { Badge, Button, Dialog, ErrorBox, Select, TextArea, TextInput } from '../ui.tsx';

interface Seat extends CastMember {
  label: string;
  hint: string;
}

const ROUND_CAPS = [2, 3, 4, 5, 6, 8];
const key = (m: { kind: string; refId: string }) => `${m.kind}:${m.refId}`;

/**
 * "New boardroom": the topic and brief, the format, the cast (library personas, your agents, personas cast from a one-line brief,
 * a saved room, or the Chair's suggestion), the round cap, a budget and the models.
 */
export function NewBoardroomDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const nav = useNavigate();
  const create = useCreateBoard();
  const suggest = useSuggestCast();
  const saveRoom = useSaveBoardRoom();
  const projects = useProjects();
  const personas = usePersonas(open);
  const agents = useAgents();
  const rooms = useBoardRooms(open);
  const workstations = useWorkstations({ enabled: open });
  const runtimes = [
    ...new Set(
      (workstations.data ?? []).flatMap((w) =>
        (w.runtimes ?? []).filter((r) => r.available).map((r) => r.id),
      ),
    ),
  ];
  // Direct API providers configured on the workstations (the session runs on one of them; the server refuses a model its
  // workstation does not offer with `runtime_unavailable`).
  const providers = unionProviders(workstations.data ?? []);
  const extras = unionExtras(workstations.data ?? []);

  const [topic, setTopic] = useState('');
  const [brief, setBrief] = useState('');
  const [format, setFormat] = useState<BoardFormat>('open');
  const [projectId, setProjectId] = useState('');
  const [roundCap, setRoundCap] = useState(String(BOARD_ROUND_CAP_DEFAULT));
  const [budget, setBudget] = useState('');
  const [seats, setSeats] = useState<Seat[]>([]);
  const [adHocName, setAdHocName] = useState('');
  const [adHocBrief, setAdHocBrief] = useState('');
  const [personaModel, setPersonaModel] = useState('');
  const [chairModel, setChairModel] = useState('');
  const [synthModel, setSynthModel] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const draft = useBoard(draftId ?? undefined);
  const start = useStartBoard(draftId ?? '');

  const has = (m: { kind: string; refId: string }) => seats.some((s) => key(s) === key(m));
  const addSeat = (s: Seat) =>
    setSeats((cur) =>
      cur.length >= BOARD_CAST_MAX || cur.some((c) => key(c) === key(s)) ? cur : [...cur, s],
    );
  const toggle = (s: Seat) => (has(s) ? setSeats((cur) => cur.filter((c) => key(c) !== key(s))) : addSeat(s));

  const models = (): BoardModels => ({
    ...(toChoice(personaModel) ? { persona: toChoice(personaModel) as ModelChoice } : {}),
    ...(toChoice(chairModel) ? { chair: toChoice(chairModel) as ModelChoice } : {}),
    ...(toChoice(synthModel) ? { synthesis: toChoice(synthModel) as ModelChoice } : {}),
  });
  const setSeatModel = (s: Seat, v: string) =>
    setSeats((cur) =>
      cur.map((c) => {
        if (key(c) !== key(s)) return c;
        const { model: _m, ...rest } = c;
        const choice = toChoice(v);
        return choice ? { ...rest, model: choice } : rest;
      }),
    );
  const cast = (): CastMember[] => seats.map(({ label: _l, hint: _h, ...m }) => m as CastMember);

  const addAdHoc = () => {
    if (!adHocName.trim() || !adHocBrief.trim()) return;
    addSeat({
      kind: 'persona',
      refId: `ad-hoc-${participantSlug(adHocName) || 'guest'}`,
      displayName: adHocName.trim(),
      stance: adHocBrief.trim(),
      label: adHocName.trim(),
      hint: adHocBrief.trim(),
    });
    setAdHocName('');
    setAdHocBrief('');
  };

  const applyRoom = (id: string) => {
    setRoomId(id);
    const r: BoardRoom | undefined = rooms.data?.find((x) => x.id === id);
    if (!r) return;
    setFormat(r.format);
    setRoundCap(String(r.roundCap));
    setSeats(
      r.cast.map((m) => ({
        ...m,
        label:
          m.displayName ??
          personas.data?.find((p) => p.key === m.refId)?.name ??
          m.refId
            .replace(/^ad-hoc-/, '')
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
        hint: m.stance ?? '',
      })),
    );
    setPersonaModel(fromChoice(r.models.persona));
    setChairModel(fromChoice(r.models.chair));
    setSynthModel(fromChoice(r.models.synthesis));
  };

  const askForCast = () => {
    if (!topic.trim()) return;
    suggest.mutate(
      { topic: topic.trim(), brief: brief.trim(), format, ...(projectId ? { projectId } : {}) },
      { onSuccess: (s) => setDraftId(s.threadId) },
    );
  };
  const suggestions = draft.data?.suggestions ?? [];
  const asking = !!draftId && draft.data?.config.suggestState === 'asking';
  const addSuggestion = (s: (typeof suggestions)[number]) =>
    addSeat(
      s.type === 'persona'
        ? { kind: 'persona', refId: s.personaKey as string, label: s.name, hint: s.why }
        : {
            kind: 'persona',
            refId: `ad-hoc-${participantSlug(s.name) || 'guest'}`,
            displayName: s.name,
            stance: s.brief ?? '',
            ...(s.seat ? { seat: s.seat } : {}),
            label: s.name,
            hint: s.brief ?? s.why,
          },
    );

  const valid = topic.trim().length > 0 && seats.length >= BOARD_CAST_MIN;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const common = {
      topic: topic.trim(),
      brief: brief.trim(),
      format,
      roundCap: Number(roundCap),
      models: models(),
      cast: cast(),
      ...(budget.trim() && Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
      ...(roomId ? { roomId } : {}),
    };
    const go = (threadId: string) => {
      onOpenChange(false);
      nav(`/boardroom/${threadId}`);
    };
    if (roomName.trim())
      saveRoom.mutate({
        name: roomName.trim(),
        format,
        roundCap: Number(roundCap),
        cast: cast(),
        models: models(),
      });
    if (draftId) start.mutate(common, { onSuccess: (r) => go(r.state.threadId) });
    else
      create.mutate({ ...common, ...(projectId ? { projectId } : {}) }, { onSuccess: (s) => go(s.threadId) });
  };

  const personaList = (personas.data ?? []).filter((p) => !['chair', 'analyst'].includes(p.key));
  const agentList = (agents.data ?? []).filter((a) => a.status !== 'retired');
  const roomList = rooms.data ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New boardroom"
      description="A Chair runs a group of personas and agents through your question. Everyone answers on their own first; you can interject at any time."
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="new-boardroom"
            loading={create.isPending || start.isPending}
            disabled={!valid}
            data-testid="start-boardroom"
          >
            Start the boardroom
          </Button>
        </>
      }
    >
      <form
        id="new-boardroom"
        onSubmit={submit}
        className="flex flex-col gap-3.5"
        noValidate
        aria-label="New boardroom"
      >
        <TextArea
          label="Topic"
          rows={2}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Should we launch a pilot with our first customer?"
          maxLength={2000}
        />
        <TextArea
          label="Brief (optional)"
          rows={3}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Context, constraints, and the options if you want them scored."
          hint="Every seat sees the topic and this brief before it hears anyone else."
        />
        <Select
          label="Format"
          value={format}
          onChange={(e) => setFormat(e.target.value as BoardFormat)}
          hint={BOARD_FORMAT_HINT[format]}
        >
          {BOARD_FORMATS.map((f) => (
            <option key={f} value={f}>
              {BOARD_FORMAT_LABEL[f]}
            </option>
          ))}
        </Select>

        <fieldset className="flex flex-col gap-2.5 rounded-card border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-fg">
            Cast ({seats.length} of {BOARD_CAST_MIN} to {BOARD_CAST_MAX})
          </legend>
          {roomList.length > 0 && (
            <Select label="Use a saved room" value={roomId} onChange={(e) => applyRoom(e.target.value)}>
              <option value="">Choose a room…</option>
              {roomList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.cast.length} seats)
                </option>
              ))}
            </Select>
          )}
          {seats.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Chosen cast">
              {seats.map((s) => (
                <li key={key(s)}>
                  <span className="inline-flex min-h-8 items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-3 text-sm text-brand-soft-fg">
                    {s.label}
                    <button
                      type="button"
                      aria-label={`Remove ${s.label}`}
                      onClick={() => toggle(s)}
                      className="inline-flex size-6 items-center justify-center rounded-full hover:bg-sunken"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {seats.length > 0 && (
            <details data-testid="seat-models">
              <summary className="cursor-pointer text-xs font-medium text-subtle">
                Model per seat (optional): mix providers
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {seats.map((s) => (
                  <ModelSelect
                    key={key(s)}
                    label={s.label}
                    ariaLabel={`Model for ${s.label}`}
                    value={fromChoice(s.model)}
                    onChange={(v) => setSeatModel(s, v)}
                    runtimes={runtimes}
                    providers={providers}
                    extras={extras}
                    defaultLabel="Room default"
                  />
                ))}
              </div>
            </details>
          )}
          <div className="flex flex-col gap-1" role="group" aria-label="Library personas">
            <p className="text-xs font-medium text-subtle">Personas</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {personaList.map((p) => {
                const seat: Seat = { kind: 'persona', refId: p.key, label: p.name, hint: p.description };
                return (
                  <li key={p.key}>
                    <label className="flex min-h-9 cursor-pointer items-start gap-2 rounded-control px-1.5 py-1 text-sm hover:bg-sunken">
                      <input
                        type="checkbox"
                        className="mt-1 size-4"
                        checked={has(seat)}
                        onChange={() => toggle(seat)}
                        aria-label={p.name}
                      />
                      <span className="min-w-0">
                        {p.icon && (
                          <span aria-hidden="true" className="mr-1" data-testid={`persona-icon-${p.key}`}>
                            {p.icon}
                          </span>
                        )}
                        <span className="font-medium text-fg">{p.name}</span>
                        {p.source === 'pack' && <span className="ml-1 text-xs text-subtle">({p.pack})</span>}
                        <span className="block text-xs text-muted [overflow-wrap:anywhere]">
                          {p.description}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          {agentList.length > 0 && (
            <div className="flex flex-col gap-1" role="group" aria-label="Your agents">
              <p className="text-xs font-medium text-subtle">
                Your agents (they speak with their own role and memory)
              </p>
              <ul className="grid gap-1 sm:grid-cols-2">
                {agentList.map((a) => {
                  const seat: Seat = { kind: 'agent', refId: a.id, label: a.name, hint: a.roleKey };
                  return (
                    <li key={a.id}>
                      <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-1.5 py-1 text-sm hover:bg-sunken">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={has(seat)}
                          onChange={() => toggle(seat)}
                          aria-label={a.name}
                        />
                        <span className="font-medium text-fg">{a.name}</span>
                        <Badge>{a.roleKey}</Badge>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="flex flex-col gap-1.5" role="group" aria-label="Cast a persona from a brief">
            <p className="text-xs font-medium text-subtle">Cast a persona from a one-line brief</p>
            <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
              <TextInput
                label="Name"
                value={adHocName}
                onChange={(e) => setAdHocName(e.target.value)}
                placeholder="Regulator"
                maxLength={100}
              />
              <TextInput
                label="Brief"
                value={adHocBrief}
                onChange={(e) => setAdHocBrief(e.target.value)}
                placeholder="A cautious compliance officer who asks what could get us fined"
                maxLength={500}
              />
              <div className="flex items-end">
                <Button
                  onClick={addAdHoc}
                  disabled={!adHocName.trim() || !adHocBrief.trim()}
                  data-testid="add-adhoc"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Add
                </Button>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={askForCast}
                disabled={!topic.trim() || asking}
                loading={suggest.isPending}
                data-testid="suggest-cast"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                Suggest a cast
              </Button>
              {asking && (
                <span className="text-sm text-muted" role="status">
                  The Chair is thinking about who should be in the room…
                </span>
              )}
              {draft.data?.config.suggestState === 'failed' && (
                <span className="text-sm text-danger" role="alert">
                  The Chair could not suggest a cast. Pick the seats yourself.
                </span>
              )}
            </div>
            {suggestions.length > 0 && (
              <ul className="flex flex-col gap-1.5" aria-label="Suggested cast" data-testid="suggestions">
                {suggestions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-start gap-2 rounded-control border border-line px-2.5 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-fg">{s.name}</span>
                      {s.type === 'adhoc' && <Badge className="ml-1.5">from a brief</Badge>}
                      <span className="block text-xs text-muted [overflow-wrap:anywhere]">
                        {s.brief ? `${s.brief}. ` : ''}
                        {s.why}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => addSuggestion(s)} aria-label={`Add ${s.name}`}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <TextInput
            label="Save this cast as a room (optional)"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="Product review"
            hint="You can pick it again for the next boardroom."
            maxLength={100}
          />
        </fieldset>

        <div className="grid gap-3.5 sm:grid-cols-3">
          <Select
            label="Round cap"
            value={roundCap}
            onChange={(e) => setRoundCap(e.target.value)}
            hint="The session ends here, or when you end it."
          >
            {ROUND_CAPS.map((n) => (
              <option key={n} value={n}>
                {n} rounds
              </option>
            ))}
          </Select>
          <TextInput
            label="Budget in USD (optional)"
            type="number"
            min="0.5"
            step="0.5"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            hint="No new turn starts once it is used up."
          />
          <Select label="Project (optional)" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}: {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-3.5 sm:grid-cols-3">
          <ModelSelect
            label="Personas run on"
            hint="Cheap by default."
            value={personaModel}
            onChange={setPersonaModel}
            runtimes={runtimes}
            providers={providers}
            extras={extras}
          />
          <ModelSelect
            label="The Chair runs on"
            hint="Picks speakers and records."
            value={chairModel}
            onChange={setChairModel}
            runtimes={runtimes}
            providers={providers}
            extras={extras}
          />
          <ModelSelect
            label="Minutes are written by"
            hint="Stronger by default."
            value={synthModel}
            onChange={setSynthModel}
            runtimes={runtimes}
            providers={providers}
            extras={extras}
          />
        </div>
        <ErrorBox error={create.error ?? start.error ?? suggest.error} />
      </form>
    </Dialog>
  );
}
