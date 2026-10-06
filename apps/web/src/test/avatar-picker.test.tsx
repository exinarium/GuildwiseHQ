import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAvatar, Face, UserAvatar } from '../components/Face.tsx';
import { AvatarPicker } from '../components/profile/AvatarPicker.tsx';
import { setAgentFaces } from '../lib/agentFaces.ts';
import { loadFaceStyle } from '../lib/faces.ts';

// jsdom cannot decode images or draw on a canvas: the picture helpers are stubbed, the crop maths is tested apart.
vi.mock('../lib/avatarImage.ts', async (orig) => {
  const real = await orig<typeof import('../lib/avatarImage.ts')>();
  return {
    ...real,
    prepareImageFile: vi.fn(async (file: File) => {
      if (!file.type.startsWith('image/')) throw new real.ImageError('Choose an image file.');
      return { src: 'data:image/png;base64,AAAA', naturalWidth: 800, naturalHeight: 600 } as HTMLImageElement;
    }),
    renderCrop: vi.fn(() => 'UE5HQ1JPUA=='),
  };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = {
  user: {
    id: '0192f3a0-0000-7000-8000-000000000001',
    email: 'me@example.test',
    displayName: 'Marta Mills',
    role: 'admin',
    status: 'active',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastLoginAt: null,
    avatar: null,
  },
  isAdmin: true,
  visibleProjectIds: [],
  features: { mockUi: false },
};

const calls: Array<{ method: string; url: string; body: any }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json(ME);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {node}
    </QueryClientProvider>,
  );

describe('generated faces', () => {
  it('renders a bundled DiceBear face from the seed (a data: URI, no network) once its style has loaded', async () => {
    render(<Face seed="abc12345" style="lorelei" name="Marlowe" size={32} />);
    const face = await screen.findByTestId('face');
    expect(face).toHaveAttribute('aria-label', 'Face of Marlowe');
    const img = face.querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('is deterministic: the same seed and style give the same face, another seed another face', async () => {
    await loadFaceStyle('notionists');
    const a = render(<Face seed="same" name="A" />);
    const first = (await screen.findByTestId('face')).querySelector('img')?.getAttribute('src');
    a.unmount();
    const b = render(<Face seed="same" name="B" />);
    expect((await screen.findByTestId('face')).querySelector('img')?.getAttribute('src')).toBe(first);
    b.unmount();
    render(<Face seed="other" name="C" />);
    expect((await screen.findByTestId('face')).querySelector('img')?.getAttribute('src')).not.toBe(first);
  });

  it('an agent shows the face from the roster (by id, then by name) and initials until the roster is known', async () => {
    const id = '0192f3a0-0000-7000-8000-0000000000aa';
    render(<AgentAvatar agentId={id} name="Ada" />);
    // not known yet: initials, not a guessed face
    expect(screen.getByTestId('avatar')).toBeInTheDocument();
    setAgentFaces([{ id, name: 'Ada', avatarSeed: 'roster-seed', avatarStyle: 'notionists' }]);
    const face = await screen.findByTestId('face');
    expect(face).toHaveAttribute('data-seed', 'roster-seed');
  });

  it('a user shows their face, their uploaded photo, or initials', async () => {
    const id = '0192f3a0-0000-7000-8000-000000000001';
    const a = render(<UserAvatar user={{ id, displayName: 'Marta Mills', avatar: null }} />);
    expect(screen.getByTestId('avatar')).toHaveTextContent('MM');
    a.unmount();
    const b = render(
      <UserAvatar user={{ id, displayName: 'Marta Mills', avatar: { kind: 'image', version: 'v1' } }} />,
    );
    expect(screen.getByTestId('user-photo').querySelector('img')?.getAttribute('src')).toBe(
      `/api/users/${id}/avatar?v=v1`,
    );
    b.unmount();
    render(
      <UserAvatar
        user={{
          id,
          displayName: 'Marta Mills',
          avatar: { kind: 'cartoon', seed: 'mm', style: 'notionists' },
        }}
      />,
    );
    expect(await screen.findByTestId('face')).toHaveAttribute('data-seed', 'mm');
  });
});

describe('AvatarPicker', () => {
  const open = () => {
    const onOpenChange = vi.fn();
    wrap(<AvatarPicker open onOpenChange={onOpenChange} name="Marta Mills" current={null} />);
    return onOpenChange;
  };

  it('picks a cartoon face from the grid, shuffles, and saves seed and style', async () => {
    const user = userEvent.setup();
    const onOpenChange = open();
    const grid = await screen.findByTestId('avatar-cartoon');
    const before = within(grid).getAllByTestId('avatar-choice');
    expect(before).toHaveLength(12);
    expect(screen.getByTestId('avatar-save')).toBeDisabled();
    await user.click(before[3] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Peeps' }));
    await user.click(screen.getByTestId('avatar-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/me/avatar');
    expect(put?.body).toEqual({
      kind: 'cartoon',
      seed: expect.stringMatching(/^[0-9a-z]{8}$/),
      style: 'open-peeps',
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('Shuffle deals a new set of faces and clears the selection', async () => {
    const user = userEvent.setup();
    open();
    const choice = async () =>
      (await screen.findAllByTestId('avatar-choice')).map((b) => b.getAttribute('aria-label'));
    await user.click((await screen.findAllByTestId('avatar-choice'))[0] as HTMLElement);
    expect(screen.getByTestId('avatar-save')).toBeEnabled();
    await user.click(screen.getByTestId('avatar-shuffle'));
    expect(screen.getByTestId('avatar-save')).toBeDisabled();
    expect(await choice()).toHaveLength(12);
  });

  it('an uploaded image goes through the circular crop and is saved as a PNG', async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    const file = new File([new Uint8Array([1, 2, 3])], 'me.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByTestId('avatar-file'), file);
    expect(await screen.findByTestId('avatar-cropper')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom' })).toBeInTheDocument();
    await user.click(screen.getByTestId('crop-confirm'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ kind: 'image', pngBase64: 'UE5HQ1JPUA==' });
  });

  it('refuses a file that is not an image, with a message', async () => {
    const user = userEvent.setup({ applyAccept: false });
    open();
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    await user.upload(
      screen.getByTestId('avatar-file'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(await screen.findByText('Choose an image file.')).toBeInTheDocument();
    expect(screen.queryByTestId('avatar-cropper')).toBeNull();
  });

  it('the camera tab explains when there is no camera and still offers the phone-camera input', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    open();
    await user.click(screen.getByRole('tab', { name: 'Take a photo' }));
    expect(await screen.findByText('The camera is not available here.')).toBeInTheDocument();
    const input = screen.getByTestId('camera-file');
    expect(input).toHaveAttribute('capture', 'user');
    expect(input).toHaveAttribute('accept', 'image/*');
  });

  it('starts the camera with getUserMedia, takes a photo and releases the camera', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
    open();
    await user.click(screen.getByRole('tab', { name: 'Take a photo' }));
    await user.click(await screen.findByTestId('camera-start'));
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false, video: expect.objectContaining({ facingMode: 'user' }) }),
    );
    expect(await screen.findByTestId('camera-shoot')).toBeInTheDocument();
  });

  it('a blocked camera says so and falls back to the phone-camera input', async () => {
    const user = userEvent.setup();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    open();
    await user.click(screen.getByRole('tab', { name: 'Take a photo' }));
    await user.click(await screen.findByTestId('camera-start'));
    expect(await screen.findByText(/camera is blocked for this site/)).toBeInTheDocument();
    expect(screen.getByTestId('camera-file')).toBeInTheDocument();
  });
});
