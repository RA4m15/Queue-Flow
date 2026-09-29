import { useTheme, DARK_THEME, LIGHT_THEME } from '../context/ThemeContext';

/**
 * Compact Dark / Light switch for the Live Counter header.
 *
 * Deliberately tiny: the board is read from across a lobby, so the control only
 * has to be findable and unmistakable, not comfortable. All state and behaviour
 * come from `useTheme()` — this component owns no theme logic of its own.
 */
export function ThemeSwitch() {
  const { theme, isLight, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      className="theme-switch"
      role="switch"
      aria-checked={isLight}
      // Announced instead of the visible text, so the control reads as a single
      // switch rather than a switch plus a stray label.
      aria-label={isLight ? 'Light theme on, switch to dark theme' : 'Dark theme on, switch to light theme'}
      onClick={toggleTheme}
    >
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-thumb" />
      </span>
      <span className="theme-switch-label" aria-hidden="true">
        {theme === LIGHT_THEME ? 'Light' : 'Dark'}
      </span>
    </button>
  );
}

export { DARK_THEME, LIGHT_THEME };
