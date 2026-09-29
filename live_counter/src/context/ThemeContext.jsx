import { useMemo, useSyncExternalStore } from 'react';
import {
  DARK_THEME,
  LIGHT_THEME,
  DEFAULT_THEME,
  getTheme,
  setTheme,
  toggleTheme,
  subscribeTheme,
} from '../services/theme';

export { DARK_THEME, LIGHT_THEME, DEFAULT_THEME };

/**
 * React binding for the Live Counter theme.
 *
 * The theme is not app state: it is a document-level preference owned by
 * `services/theme.js` and painted entirely from CSS custom properties. So this
 * is a plain external-store subscription rather than a context provider — no
 * extra wrapper around the tree, and any component can read the theme on its own,
 * including components rendered in isolation (the standalone board, tests).
 *
 * useSyncExternalStore is what makes that safe: a change made in another tab, or
 * by the pre-paint bootstrap script, re-renders subscribers with the real value
 * instead of leaving a stale label on the control.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);

  return useMemo(
    () => ({
      theme,
      isDark: theme === DARK_THEME,
      isLight: theme === LIGHT_THEME,
      setTheme,
      toggleTheme,
    }),
    [theme]
  );
}
