/**
 * The shape of the voice-over of every video: warm, clear, second person. Every cue is one spoken passage; the
 * recording waits for the audio of a cue to finish before it moves on, and the same text becomes the WebVTT captions.
 * `speech` (when given) is what the voice reads, spelled out for pronunciation (for example "H Q"); `text` is what
 * viewers read.
 */
export interface Cue {
  id: string;
  text: string;
  speech?: string;
}

export interface NarratedChapter {
  /** The chapter name shown under the video. */
  title: string;
  /** The short on-screen banner. */
  banner: string;
  cues: Cue[];
}
