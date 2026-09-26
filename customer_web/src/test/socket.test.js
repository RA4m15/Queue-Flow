import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as socketService from '../services/socket';

describe('Socket.IO Client & Reconnection (Requirements 11 & 12)', () => {
  beforeEach(() => {
    socketService.disconnectSocket();
  });

  it('Requirement 11: connects and registers status callbacks', () => {
    let latestStatus = null;
    const unsub = socketService.onSocketStatus((status) => {
      latestStatus = status;
    });

    const s = socketService.connectSocket();
    expect(s).toBeDefined();

    // Trigger the registered connect listeners
    const connectListeners = s.listeners('connect');
    expect(connectListeners.length).toBeGreaterThan(0);
    connectListeners.forEach((fn) => fn());

    expect(latestStatus).toBe('connected');

    unsub();
  });

  it('Requirement 12: triggers reconnect listeners to reload authoritative state upon reconnection', () => {
    let reconnectCalled = false;
    const unsub = socketService.onSocketReconnect(() => {
      reconnectCalled = true;
    });

    const s = socketService.connectSocket();

    // Trigger reconnect on manager
    s.io.emit('reconnect');

    expect(reconnectCalled).toBe(true);
    unsub();
  });

  it('Requirement 11b: joinCenterRoom properly subscribes to center room', () => {
    const s = socketService.connectSocket();
    const emitSpy = vi.spyOn(s, 'emit');

    socketService.joinCenterRoom('507f1f77bcf86cd799439011');
    // Simulate connection event to ensure join:center is emitted
    const connectListeners = s.listeners('connect');
    connectListeners.forEach((fn) => fn());

    expect(emitSpy).toHaveBeenCalledWith('join:center', '507f1f77bcf86cd799439011');
  });
});
