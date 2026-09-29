import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTheme } from '../context/ThemeContext';
import { ThemeSetting } from '../components/ThemeSetting';
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
import { storage } from '../services/storage';

const root = document.documentElement;

function currentTheme() {
  return root.getAttribute('data-theme') || DARK_THEME;
}

describe('Customer Web theme service', () => {
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

  it('restores the persisted choice after a refresh', () => {
    setTheme(LIGHT_THEME);

    // A refresh rebuilds the DOM from scratch; storage survives.
    root.removeAttribute('data-theme');
    expect(initTheme()).toBe(LIGHT_THEME);
    expect(currentTheme()).toBe(LIGHT_THEME);
  });

  it('toggles between the two themes', () => {
    expect(toggleTheme()).toBe(LIGHT_THEME);
    expect(toggleTheme()).toBe(DARK_THEME);
  });

  it('treats a missing or corrupt stored value as dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight-neon');
    expect(getTheme()).toBe(DARK_THEME);
    expect(initTheme()).toBe(DARK_THEME);
  });

  it('notifies subscribers so the control stays truthful', () => {
    const seen = [];
    const unsubscribe = subscribeTheme((t) => seen.push(t));

    setTheme(LIGHT_THEME);
    toggleTheme();

    expect(seen).toEqual([LIGHT_THEME, DARK_THEME]);
    unsubscribe();
  });
});

describe('Customer Web theme control', () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    root.removeAttribute('data-theme');
  });

  it('offers both Dark and Light, with Dark selected by default', () => {
    render(<ThemeSetting />);

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Dark');
    expect(options[1]).toHaveTextContent('Light');
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(options[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('selects Light, applies it and persists it', async () => {
    const user = userEvent.setup();
    render(<ThemeSetting />);

    await user.click(screen.getByRole('radio', { name: /light/i }));

    expect(screen.getByRole('radio', { name: /light/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute('aria-checked', 'false');
    expect(currentTheme()).toBe(LIGHT_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(LIGHT_THEME);
  });

  it('selects back to Dark and persists the second choice too', async () => {
    const user = userEvent.setup();
    render(<ThemeSetting />);

    await user.click(screen.getByRole('radio', { name: /light/i }));
    await user.click(screen.getByRole('radio', { name: /dark/i }));

    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute('aria-checked', 'true');
    expect(currentTheme()).toBe(DARK_THEME);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(DARK_THEME);
  });

  it('renders on the correct theme when a preference was already stored', () => {
    localStorage.setItem(THEME_STORAGE_KEY, LIGHT_THEME);
    // main.jsx / the pre-paint bootstrap do exactly this before the first render.
    initTheme();

    render(<ThemeSetting />);

    expect(screen.getByRole('radio', { name: /light/i })).toHaveAttribute('aria-checked', 'true');
    expect(currentTheme()).toBe(LIGHT_THEME);
  });

  it('reflects a theme change it did not make itself', () => {
    render(<ThemeSetting />);

    // Simulates another tab, or a customer who changed it on another page.
    act(() => setTheme(LIGHT_THEME));

    expect(screen.getByRole('radio', { name: /light/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('uses its own storage key, so queue session data is untouched', async () => {
    const user = userEvent.setup();
    storage.setToken('a-jwt');
    storage.setUser({ _id: 'u1', name: 'Ada' });

    render(<ThemeSetting />);
    await user.click(screen.getByRole('radio', { name: /light/i }));

    // Appearance changed...
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(LIGHT_THEME);
    // ...and nothing about the customer, the session or the offline caches moved.
    expect(storage.getToken()).toBe('a-jwt');
    expect(storage.getUser()).toEqual({ _id: 'u1', name: 'Ada' });
    expect(localStorage.getItem('queueflow_customer_token')).toBe('a-jwt');
  });

  it('survives a sign-out, which clears session caches but not the theme', () => {
    storage.setToken('a-jwt');
    setTheme(LIGHT_THEME);

    storage.clearAllSession();

    expect(storage.getToken()).toBeNull();
    expect(getTheme()).toBe(LIGHT_THEME);
    expect(currentTheme()).toBe(LIGHT_THEME);
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
