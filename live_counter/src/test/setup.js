import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Realtime assertions in this suite wait for a real async boundary: a mocked
// socket event fires, the board re-fetches authoritative state, React commits
// the repaint, and only then may the assertion run. The testing-library default
// of 1000 ms is occasionally too tight when the whole file runs alongside the
// speech-synthesis and full-stack suites on a loaded machine, which produced
// failures that were pure timing, never behaviour. Raising the ceiling keeps
// every assertion exactly as strict while removing the flake.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
