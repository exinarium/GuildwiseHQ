/**
 * The offline voice and the ffmpeg helpers of the help videos now live in `@aom/video` (packages/video), which the
 * video renderer shares: same Kokoro `af_heart` voice and the same speech cache key. This file keeps the old import path.
 */
export {
  cacheKey,
  ENGINE,
  findFfmpeg,
  mux,
  SPEED,
  type Spoken,
  speak,
  toMp4,
  VIDEO_HOME,
  VOICE,
  VOICE_LABEL,
  voiceAvailable,
  vtt,
  wavSeconds,
} from '@aom/video';
