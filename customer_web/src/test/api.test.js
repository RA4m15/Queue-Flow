import { describe, it, expect, vi, beforeEach } from 'vitest';
import api, { tokenAPI, serviceCenterAPI } from '../services/api';
import { storage } from '../services/storage';

describe('Customer API & Authoritative Token Security (Requirements 7, 8, 9, 16)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('Requirement 7 & 9: joinQueue sends only centerId and serviceId with NO client-generated token number', async () => {
    const postSpy = vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'success',
      data: {
        token: {
          _id: 'token_123',
          tokenCode: 'A001',
          tokenNumber: 1,
          status: 'WAITING',
        },
      },
    });

    const centerId = '507f1f77bcf86cd799439011';
    const serviceId = '507f191e810c19729de860ea';

    await tokenAPI.joinQueue(centerId, serviceId);

    expect(postSpy).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = postSpy.mock.calls[0];

    expect(endpoint).toBe('/tokens');
    expect(payload).toEqual({ centerId, serviceId });

    // Strictly ensure client NEVER generates tokenCode or tokenNumber
    expect(payload.tokenCode).toBeUndefined();
    expect(payload.tokenNumber).toBeUndefined();
    expect(payload.status).toBeUndefined();
  });

  it('Requirement 8: receives authoritative token from backend response', async () => {
    const mockToken = {
      _id: 'token_abc123',
      tokenCode: 'B042',
      tokenNumber: 42,
      centerId: 'center_1',
      serviceId: 'service_1',
      status: 'WAITING',
      currentPosition: 3,
    };

    vi.spyOn(api, 'post').mockResolvedValueOnce({
      status: 'success',
      data: { token: mockToken },
    });

    const res = await tokenAPI.joinQueue('center_1', 'service_1');
    expect(res.data.token).toEqual(mockToken);
    expect(res.data.token.tokenCode).toBe('B042');
  });

  it('Requirement 16: handles unauthorized 401 response by purging stored token and notifying listeners', async () => {
    storage.setToken('expired_or_invalid_jwt');
    storage.setUser({ name: 'Test' });

    let unauthorizedEventFired = false;
    window.addEventListener('queueflow:unauthorized', () => {
      unauthorizedEventFired = true;
    });

    // Mock axios error response with status 401
    const error401 = {
      response: {
        status: 401,
        data: { message: 'Authentication required' },
      },
      message: 'Request failed with status code 401',
    };

    // Trigger error through interceptor
    const rejectedPromise = api.interceptors.response.handlers[0].rejected(error401);
    await expect(rejectedPromise).rejects.toThrow('Authentication required');

    expect(storage.getToken()).toBeNull();
    expect(storage.getUser()).toBeNull();
    expect(unauthorizedEventFired).toBe(true);
  });
});
