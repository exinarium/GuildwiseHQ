import {
  AVATAR_STYLE_LABEL,
  AVATAR_STYLES,
  type AvatarStyle,
  DEFAULT_AVATAR_STYLE,
  randomAvatarSeed,
  type UserAvatar as UserAvatarValue,
} from '@aom/shared';
import { Shuffle } from 'lucide-react';
import { useState } from 'react';
import { useSetMyAvatar } from '../../api/queries/auth.ts';
import { ImageError, prepareImageFile } from '../../lib/avatarImage.ts';
import { Face } from '../Face.tsx';
import { Tabs } from '../ui/Tabs.tsx';
import { Button, Dialog, ErrorBox, Segmented } from '../ui.tsx';
import { CameraCapture } from './CameraCapture.tsx';
import { ImageCropper } from './ImageCropper.tsx';

const GRID = 12;
const seeds = () => Array.from({ length: GRID }, () => randomAvatarSeed());

type Source = 'cartoon' | 'photo' | 'upload';

/**
 * Your picture, three ways: pick a generated cartoon face (a grid of options and a shuffle), take a photo with the
 * camera, or upload an image. A photo or an upload goes through a circular crop first. The image is stored on the server.
 */
export function AvatarPicker({
  open,
  onOpenChange,
  name,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  current: UserAvatarValue | null;
}) {
  const save = useSetMyAvatar();
  const [source, setSource] = useState<Source>('cartoon');
  const [style, setStyle] = useState<AvatarStyle>(
    current?.kind === 'cartoon' ? current.style : DEFAULT_AVATAR_STYLE,
  );
  const [choices, setChoices] = useState<string[]>(() => {
    const list = seeds();
    if (current?.kind === 'cartoon') list[0] = current.seed;
    return list;
  });
  const [seed, setSeed] = useState<string | null>(current?.kind === 'cartoon' ? current.seed : null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [problem, setProblem] = useState<Error | null>(null);

  const close = () => {
    setImage(null);
    setProblem(null);
    onOpenChange(false);
  };
  const done = () => close();
  const fromFile = async (file: File) => {
    setProblem(null);
    try {
      setImage(await prepareImageFile(file));
    } catch (e) {
      setProblem(e instanceof ImageError ? e : new Error('That image could not be opened.'));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="Your picture"
      description="It shows in the sidebar, the account menu and on the answers you give at the desk."
      size="lg"
    >
      {image ? (
        <ImageCropper
          image={image}
          busy={save.isPending}
          onCancel={() => setImage(null)}
          onDone={(pngBase64) => save.mutate({ kind: 'image', pngBase64 }, { onSuccess: done })}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <Tabs
            label="Where the picture comes from"
            prefix="avatar-source"
            value={source}
            onChange={(id) => setSource(id as Source)}
            tabs={[
              { id: 'cartoon', label: 'Cartoon' },
              { id: 'photo', label: 'Take a photo' },
              { id: 'upload', label: 'Upload' },
            ]}
          />
          <div
            role="tabpanel"
            id={`avatar-source-panel-${source}`}
            aria-labelledby={`avatar-source-tab-${source}`}
            className="min-h-72"
          >
            {source === 'cartoon' && (
              <div className="flex flex-col gap-4" data-testid="avatar-cartoon">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Segmented
                    label="Style"
                    value={style}
                    onChange={setStyle}
                    options={AVATAR_STYLES.map((s) => ({ value: s, label: AVATAR_STYLE_LABEL[s] }))}
                  />
                  <Button
                    onClick={() => {
                      setChoices(seeds());
                      setSeed(null);
                    }}
                    data-testid="avatar-shuffle"
                  >
                    <Shuffle aria-hidden="true" className="size-4" />
                    Shuffle
                  </Button>
                </div>
                <ul className="grid grid-cols-4 gap-3 sm:grid-cols-6" aria-label="Faces to choose from">
                  {choices.map((s) => (
                    <li key={s} className="flex justify-center">
                      <button
                        type="button"
                        aria-label={`Pick this face${seed === s ? ' (selected)' : ''}`}
                        aria-pressed={seed === s}
                        data-testid="avatar-choice"
                        onClick={() => setSeed(s)}
                        className={`rounded-full p-0.5 ring-2 ring-offset-2 ring-offset-surface transition-shadow focus-visible:outline-none focus-visible:ring-ring ${
                          seed === s ? 'ring-brand' : 'ring-transparent hover:ring-line'
                        }`}
                      >
                        <Face seed={s} style={style} name={name} size={56} label="Face option" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {source === 'photo' && <CameraCapture onPhoto={setImage} onFile={(f) => void fromFile(f)} />}
            {source === 'upload' && (
              <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="avatar-upload">
                <p className="max-w-xs text-sm text-muted">
                  Choose a picture from this device. You will crop it to a circle next.
                </p>
                <label className="inline-flex cursor-pointer items-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:bg-brand-hover focus-within:ring-2 focus-within:ring-ring/50 [@media(pointer:coarse)]:min-h-11">
                  Choose an image
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    data-testid="avatar-file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void fromFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            )}
          </div>
          <ErrorBox error={problem ?? save.error} />
          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-3">
            <Button
              variant="ghost"
              disabled={save.isPending || !current}
              onClick={() => save.mutate({ kind: 'none' }, { onSuccess: done })}
            >
              Remove my picture
            </Button>
            <span className="flex gap-2">
              <Button onClick={close}>Cancel</Button>
              {source === 'cartoon' && (
                <Button
                  variant="primary"
                  disabled={!seed}
                  loading={save.isPending}
                  data-testid="avatar-save"
                  onClick={() => seed && save.mutate({ kind: 'cartoon', seed, style }, { onSuccess: done })}
                >
                  Use this face
                </Button>
              )}
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
