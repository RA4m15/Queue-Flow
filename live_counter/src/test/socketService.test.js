import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal stand-in for a socket.io-client socket: records the handlers the
// service registers so a test can deliver an event exactly as the server would.
function createFakeSocket() {
  const handlers = new Map();
  const emitted = [];
  return {
    id: 'fake-socket',
    connected: true,
    io: { on: vi.fn(), removeAllListeners: vi.fn() },
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    handlers,
    emitted,
    deliver(event, payload) {
      const h = handlers.get(event);
      if (h) h(payload);
    },
  };
}

const fake = { current: null, ioArgs: null };

vi.mock('socket.io-client', () => ({
  io: (url, args) => {
    fake.ioArgs = { url, args };
    fake.current = createFakeSocket();
    return fake.current;
  },
}));

const CENTER = '6ab030edfb8baa6b361738d8';
const OTHER_CENTER = '6ab77948e712763a816b1d7c';

describe('live counter socket service', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../services/socket');
  });

  afterEach(() => {
    mod.closeDisplaySocket();
  });

  it('connects with the display token and joins the selected center room', () => {
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 'display.jwt.token', onEvent: () => {} });

    expect(fake.ioArgs.url).toBeTruthy();
    expect(fake.ioArgs.args.auth.token).toBe('Bearer display.jwt.token');
    expect(fake.ioArgs.args.reconnection).toBe(true);

    // The room join only happens once the socket is actually connected.
    expect(fake.current.emitted).toHaveLength(0);
    fake.current.deliver('connect');
    expect(fake.current.emitted).toEqual([{ event: 'join:center', payload: CENTER }]);
  });

  it('re-joins the center room after a reconnect', () => {
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 't', onEvent: () => {} });
    fake.current.deliver('connect');
    fake.ioArgs = null;
    // The manager-level reconnect handler re-emits the room join.
    const reconnectHandler = fake.current.io.on.mock.calls.find((c) => c[0] === 'reconnect');
    expect(reconnectHandler).toBeTruthy();
    reconnectHandler[1]();
    expect(fake.current.emitted.filter((e) => e.event === 'join:center').length).toBe(2);
  });

  it('forwards an event that belongs to the selected center', () => {
    const seen = [];
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 't', onEvent: (e, d) => seen.push([e, d]) });

    fake.current.deliver('queue.updated', { centerId: CENTER, waitingCount: 4 });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('queue.updated');
  });

  it('forwards an event that carries no centerId (already room-scoped)', () => {
    const seen = [];
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 't', onEvent: (e, d) => seen.push([e, d]) });

    fake.current.deliver('token.called', { token: { tokenCode: 'A-001' }, counter: { name: 'C1' } });
    expect(seen).toHaveLength(1);
  });

  it('DROPS an event that explicitly belongs to a different center', () => {
    const seen = [];
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 't', onEvent: (e, d) => seen.push([e, d]) });

    fake.current.deliver('queue.updated', { centerId: OTHER_CENTER, waitingCount: 99 });
    fake.current.deliver('crowd.updated', { centerId: OTHER_CENTER, currentCrowd: 500 });
    fake.current.deliver('token.called', { token: { tokenCode: 'Z-999', centerId: OTHER_CENTER } });

    expect(seen).toHaveLength(0);
  });

  it('subscribes to every authoritative queue and telemetry event', () => {
    mod.initDisplaySocket({ centerId: CENTER, displayToken: 't', onEvent: () => {} });

    [
      'token.called', 'token.serving', 'token.completed', 'token.skipped',
      'token.cancelled', 'token.expired', 'queue.updated',
      'counter.updated', 'crowd.updated',
    ].forEach((name) => {
      expect(fake.current.handlers.has(name), `missing subscription: ${name}`).toBe(true);
    });
  });
});
