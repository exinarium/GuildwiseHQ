import { useEffect, useState } from 'react';

/** `value` after it stopped changing for `ms`; `flush()` takes the current value at once (Enter on a soft keyboard). */
export function useDebounced<T>(value: T, ms: number): [T, () => void] {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [v, () => setV(value)];
}
