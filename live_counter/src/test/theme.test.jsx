import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTheme } from '../context/ThemeContext';
import { ThemeSwitch } from '../components/ThemeSwitch';
import {
  DARK_THEME,
  LIGHT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  getTheme,
  initTheme,
  setTheme,
  subscribeTheme,
  toggleTheme,
} from '../services/theme';

const root = document.documentElement;

function currentTheme() {
  return root.getAttribute('data-theme') || DARK_THEME;
}

describe('Live Counter theme service', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
    root.style.removeProperty('color-scheme');
  });

  afterEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('defaults to dark when nothing has been chosen', () => {
    expect(getTheme()).toBe(DARK_THEME);
    expect(initTheme()).toBe(DARK_THEME);
    // Dark is the default, so it must not even carry the opt-in attribute.
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('exposes the chosen theme through the document element', () => {
    applyTheme(LIGHT_THEME);
    expect(root.getAttribute('data-theme')).toBe(LIGHT_THEME);
    expect(root.style.colorScheme).toBe('light');

    applyTheme(DARK_THEME);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('persists the choice in localStorage', () => {
    setTheme(LIGHT_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(LIGHT_THEME);
    expect(getTheme()).toBe(LIGHT_THEME);
  });

  it('restores the persisted choice after a reload', () => {
    setTheme(LIGHT_THEME);

    // Simulate a fresh page load: the DOM is rebuilt from scratch, storage is not.
    root.removeAttribute('data-theme');
    expect(initTheme()).toBe(LIGHT_THEME);
    expect(currentTheme()).toBe(LIGHT_THEME);
  });

  it('toggles between the two themes', () => {
    expect(toggleTheme()).toBe(LIGHT_THEME);
    expect(toggleTheme()).toBe(DARK_THEME);
    expect(toggleTheme()).toBe(LIGHT_THEME);
  });

  it('treats a missing or corrupt stored value as dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight-neon');
    expect(getTheme()).toBe(DARK_THEME);
    expect(initTheme()).toBe(DARK_THEME);
  });

  it('notifies subscribers so a control stays truthful', () => {
    const seen = [];
    const unsubscribe = subscribeTheme((t) => seen.push(t));

    setTheme(LIGHT_THEME);
    toggleTheme();

    expect(seen).toEqual([LIGHT_THEME, DARK_THEME]);
    unsubscribe();
  });
});

describe('Live Counter theme switch', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('starts on dark and switches to light when activated', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);

    const control = screen.getByRole('switch');
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(currentTheme()).toBe(DARK_THEME);

    await user.click(control);

    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(currentTheme()).toBe(LIGHT_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(LIGHT_THEME);
  });

  it('switches back to dark and persists the second choice too', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);

    const control = screen.getByRole('switch');
    await user.click(control);
    await user.click(control);

    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(currentTheme()).toBe(DARK_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK_THEME);
  });

  it('renders on the correct theme when a preference was already stored', () => {
    localStorage.setItem(THEME_STORAGE_KEY, LIGHT_THEME);
    // main.jsx / the pre-paint bootstrap do exactly this before the first render.
    initTheme();

    render(<ThemeSwitch />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(currentTheme()).toBe(LIGHT_THEME);
  });

  it('reflects a theme change it did not make itself', () => {
    render(<ThemeSwitch />);
    const control = screen.getByRole('switch');

    // Simulates another tab of the same display.
    act(() => setTheme(LIGHT_THEME));

    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('changes nothing but the theme', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);

    // A theme change must be inert for everything the board streams.
    let events = 0;
    const unsubscribe = subscribeTheme(() => {
      events += 1;
    });
    await user.click(screen.getByRole('switch'));
    unsubscribe();

    expect(events).toBe(1);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(LIGHT_THEME);
  });
});

describe('useTheme', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('reports the current theme without a provider', () => {
    function Probe() {
      const { theme, isDark, isLight } = useTheme();
      return <span data-testid="probe">{`${theme}:${isDark}:${isLight}`}</span>;
    }

    setTheme(LIGHT_THEME);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('light:false:true');

    act(() => setTheme(DARK_THEME));
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:true:false');
  });
});

describe('Live Counter theme does not disturb the rest of the board', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('keeps the live badge and header controls mounted in both themes', () => {
    render(
      <div className="live-display-shell" data-testid="live-counter-panel">
        <header className="display-card display-header" role="banner">
          <span className="brand-logo">QUEUEFLOW</span>
          <div className="header-status-group">
            <div className="live-badge live" aria-live="polite">
              <span className="pulse-dot" />
              <span>LIVE</span>
            </div>
            <div className="header-controls">
              <ThemeSwitch />
            </div>
          </div>
        </header>
      </div>
    );

    expect(screen.getByTestId('live-counter-panel')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('QUEUEFLOW')).toBeInTheDocument();

    setTheme(LIGHT_THEME);

    expect(screen.getByTestId('live-counter-panel')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });
});
