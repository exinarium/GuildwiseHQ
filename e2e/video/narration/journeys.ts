import type { Cue, NarratedChapter } from './types.ts';

/** The voice-over of the Journeys video (slug `journeys`, sidebar entry Journeys; help article `journeys#design`). */
export const INTRO: Cue[] = [
  {
    id: 'intro-1',
    text: 'A journey is one process, from first contact to outcome. It links your workflows with handoffs, and they all work on one shared record, such as a tenant.',
  },
];

export const CHAPTERS: NarratedChapter[] = [
  {
    title: 'Start from a template',
    banner: 'New journey',
    cues: [
      {
        id: 'c1-a',
        text: 'Open Journeys in the sidebar. This lists the journeys of your projects.',
      },
      {
        id: 'c1-b',
        text: 'Choose New journey and start from the Rentals template. It opens in the designer.',
      },
    ],
  },
  {
    title: 'Steps and handoffs',
    banner: 'Steps and handoffs',
    cues: [
      {
        id: 'c2-a',
        text: 'The designer lists the steps in order: the lead, the viewing, the application, a wait for documents, an approval, and the lease. A workflow step runs one of your workflows.',
      },
      {
        id: 'c2-b',
        text: 'A handoff says where the record goes when a step finishes. You can send it back to an earlier step, or add a condition.',
      },
    ],
  },
  {
    title: 'Waits and gates',
    banner: 'Waits and gates',
    cues: [
      {
        id: 'c3-a',
        text: 'A wait pauses the journey until something happens. Here it waits for a form from the client. Pick the form to send, set the longest wait, and choose what happens when time runs out.',
      },
      {
        id: 'c3-b',
        text: 'A gate asks a person to approve or reject before the journey goes on. You choose who decides and what they are asked.',
      },
    ],
  },
  {
    title: 'Webhooks',
    banner: 'Webhooks',
    cues: [
      {
        id: 'c4-a',
        text: 'Webhooks let an outside system start the journey, or end a wait, with a signed message. Name it, say what it does, and tell Guildwise where to find the record id in the message.',
      },
      {
        id: 'c4-b',
        text: 'The address and the secret are shown once, so copy them now. Then save the journey.',
      },
    ],
  },
  {
    title: 'Follow an instance',
    banner: 'Instance',
    cues: [
      {
        id: 'c5-a',
        text: 'Running lists the records moving through your journeys. Open one to see where it is, and its history with the time of every step.',
      },
      {
        id: 'c5-b',
        text: 'The waits panel shows what the journey is waiting for, with the deadline and the personal link for the client. References list the documents and submissions attached to the record, but never their content.',
      },
    ],
  },
];

export const OUTRO: Cue[] = [
  {
    id: 'outro-1',
    text: 'That is Journeys: your workflows, linked by handoffs, with waits and gates where a person or a client has to act.',
  },
];

export const allCues = (): Cue[] => [...INTRO, ...CHAPTERS.flatMap((c) => c.cues), ...OUTRO];
