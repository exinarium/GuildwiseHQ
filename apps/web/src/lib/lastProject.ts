const KEY = 'aom:lastProjectKey';
export const getLastProjectKey = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setLastProjectKey = (key: string): void => {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    /* storage unavailable */
  }
};
