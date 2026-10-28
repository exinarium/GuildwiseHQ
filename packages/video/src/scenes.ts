import { readFileSync } from 'node:fs';
import type { VideoScene } from '@aom/shared';
import { assetPath } from './assets.ts';

export type Orientation = 'landscape' | 'portrait';

export const SIZES: Record<Orientation, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

export const THUMB_SIZE = { width: 1280, height: 720 };

/** Pictures the image scenes may show, as local file paths. Missing ones fall back to the logo. */
export interface SceneImages {
  cover?: string;
  release?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function dataUrl(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? 'png';
  return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}`;
}

const logoUrl = (): string => dataUrl(assetPath('logo-mark.svg'));

const page = (orient: Orientation | 'thumb', body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${readFileSync(assetPath('templates/scene.css'), 'utf8')}</style></head><body class="${orient}">${body}</body></html>`;

const brand = (): string => `<div class="brand"><img src="${logoUrl()}" alt="">Guildwise HQ</div>`;

/** The geometry of the help video well in the branded frame (pixels of the full frame). */
export function clipBox(orient: Orientation): { x: number; y: number; w: number; h: number; strip: number } {
  return orient === 'landscape'
    ? { x: 160, y: 140, w: 1600, h: 900, strip: 100 }
    : { x: 40, y: 640, w: 1000, h: 562, strip: 220 };
}

/** The branded frame a help video clip is overlaid on (the clip goes into the well). */
export function clipFrameHtml(orient: Orientation, title: string): string {
  const b = clipBox(orient);
  return page(
    orient,
    `<style>:root{--strip:${b.strip}px}</style>
<div class="strip"><small>Guildwise HQ</small>${esc(title)}</div>
<div class="well" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"></div>`,
  );
}

/** Languages that are not worth a label on a code card: plain text has no language to name. */
const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none']);
/** The language label of a code card, or '' when it is plain text (the card then shows no label). */
export const codeLangLabel = (lang: string): string =>
  PLAIN_LANGS.has(lang.trim().toLowerCase()) ? '' : lang.trim();

/** HTML of a (non clip) scene card. */
export function sceneHtml(scene: VideoScene, orient: Orientation, images: SceneImages = {}): string {
  switch (scene.type) {
    case 'title':
      return page(
        orient,
        `<div class="kicker">Guildwise HQ</div><h1>${esc(scene.heading)}</h1>${scene.sub ? `<div class="sub">${esc(scene.sub)}</div>` : ''}${brand()}`,
      );
    case 'points':
      return page(
        orient,
        `<h2>${esc(scene.heading)}</h2><ul>${scene.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>${brand()}`,
      );
    case 'quote':
      return page(orient, `<div class="quote">${esc(scene.text)}</div>${brand()}`);
    case 'code':
      return page(
        orient,
        `${codeLangLabel(scene.lang) ? `<div class="lang">${esc(scene.lang)}</div>` : ''}<pre>${esc(scene.code)}</pre>${brand()}`,
      );
    case 'image': {
      const file =
        scene.src === 'cover' ? images.cover : scene.src === 'release' ? images.release : undefined;
      if (!file)
        return page(
          orient,
          `<div class="center" style="display:flex;flex-direction:column;align-items:center"><img class="logo-big" src="${logoUrl()}" alt=""><h1>Guildwise HQ</h1>${scene.caption ? `<div class="sub">${esc(scene.caption)}</div>` : ''}</div>`,
        );
      return page(
        orient,
        `<div class="image" style="background-image:url('${dataUrl(file)}')"></div>${scene.caption ? `<div class="caption">${esc(scene.caption)}</div>` : ''}${brand()}`,
      );
    }
    case 'outro':
      return page(
        orient,
        `<div class="center" style="display:flex;flex-direction:column;align-items:center"><img class="logo-big" src="${logoUrl()}" alt=""><h1>${esc(scene.heading ?? 'Guildwise HQ')}</h1><div class="sub">${esc(scene.sub ?? 'Open source. Link in the description.')}</div></div>`,
      );
    case 'clip':
      throw new Error('clip scenes use clipFrameHtml');
  }
}

/** The 1280x720 thumbnail. */
export function thumbnailHtml(title: string, kicker: string): string {
  return page('thumb', `<div class="kicker">${esc(kicker)}</div><h1>${esc(title)}</h1>${brand()}`);
}
