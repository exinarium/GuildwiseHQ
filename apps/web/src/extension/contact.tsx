import { createContext, useContext } from 'react';

/** The "Contact us" dialog of a hosted build. The open-source app has none: `available` is false. */
export interface ContactApi {
  available: boolean;
  open: (prefill?: unknown) => void;
}

export const ContactContext = createContext<ContactApi>({ available: false, open: () => undefined });

export const useContact = (): ContactApi => useContext(ContactContext);
