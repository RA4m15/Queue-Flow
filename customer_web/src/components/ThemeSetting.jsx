import { useTheme, DARK_THEME, LIGHT_THEME } from '../context/ThemeContext';

/**
 * Inline 16px stroke icons, matching the hand-rolled SVG already used in the
 * Navbar. This app has no icon package, and pulling one in for two glyphs would
 * be a heavier dependency than the control it serves.
 */
function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

const OPTIONS = [
  { value: DARK_THEME, label: 'Dark', Icon: MoonIcon },
  { value: LIGHT_THEME, label: 'Light', Icon: SunIcon },
];

/**
 * Dark / Light segmented control for the Profile page.
 *
 * A segmented control rather than a switch because both options are named: a
 * customer should be able to read the exact state they are choosing, not infer
 * it from a knob. Sized for touch, like every other control on this app.
 *
 * All state and behaviour come from `useTheme()` — this component holds no theme
 * logic of its own.
 */
export function ThemeSetting() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="theme-segment"
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-setting"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const isSelected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className="theme-segment-option"
            data-selected={isSelected}
            onClick={() => setTheme(value)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
