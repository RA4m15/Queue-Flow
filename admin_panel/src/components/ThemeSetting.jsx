import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme, DARK_THEME, LIGHT_THEME } from '../context/ThemeContext';

const OPTIONS = [
  { value: DARK_THEME, label: 'Dark', Icon: Moon },
  { value: LIGHT_THEME, label: 'Light', Icon: Sun },
];

/**
 * Dark / Light segmented control for the Profile page.
 *
 * A segmented control rather than a switch because both options are named: an
 * administrator setting up a shared console should be able to see and point at
 * the exact state they are choosing, not infer it from a knob.
 *
 * All state and behaviour come from `useTheme()` — this component holds no theme
 * logic of its own.
 */
export default function ThemeSetting() {
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
            <Icon size={15} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
