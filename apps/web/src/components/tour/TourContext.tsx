import { createContext, useContext } from 'react';

/** What the rest of the app (the Help centre, the palette) can ask of the first-login tour. */
export interface TourApi {
  /** There is a tour for this user (a signed-in work or platform account). */
  available: boolean;
  /** The tour is on screen now. */
  active: boolean;
  status: 'new' | 'in_progress' | 'completed' | 'dismissed';
  /** The saved step (0-based) and the number of steps of this user's tour. */
  step: number;
  total: number;
  /** Replay from the first step. */
  start: () => void;
  /** Carry on from the saved step (after Skip or a closed tab). */
  resume: () => void;
}

export const NO_TOUR: TourApi = {
  available: false,
  active: false,
  status: 'completed',
  step: 0,
  total: 0,
  start: () => undefined,
  resume: () => undefined,
};

export const TourContext = createContext<TourApi>(NO_TOUR);
export const useTour = (): TourApi => useContext(TourContext);
