import { useEffect, useState } from 'react';

/** `true` only after `ms` of being mounted/active: skeletons use it so fast responses never flash a placeholder. */
export function useDelayedFlag(active = true, ms = 150): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return on;
}
