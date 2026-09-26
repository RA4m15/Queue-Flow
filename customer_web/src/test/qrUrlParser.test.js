import { describe, it, expect } from 'vitest';
import { parseJoinUrl, isValidMongoId } from '../utils/qrUrlParser';

describe('QR Join URL Parser (Requirements 13 & 14)', () => {
  const validCenterId = '507f1f77bcf86cd799439011';
  const validServiceId = '507f191e810c19729de860ea';

  it('validates 24-hex MongoDB ObjectIds', () => {
    expect(isValidMongoId(validCenterId)).toBe(true);
    expect(isValidMongoId('invalid-id-123')).toBe(false);
    expect(isValidMongoId('')).toBe(false);
    expect(isValidMongoId(null)).toBe(false);
  });

  it('parses valid custom scheme queueflow://join with centerId and serviceId', () => {
    const input = `queueflow://join?centerId=${validCenterId}&serviceId=${validServiceId}`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(validCenterId);
    expect(result.serviceId).toBe(validServiceId);
    expect(result.error).toBeNull();
  });

  it('parses valid custom scheme queueflow://join with centerId only', () => {
    const input = `queueflow://join?centerId=${validCenterId}`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(validCenterId);
    expect(result.serviceId).toBeNull();
    expect(result.error).toBeNull();
  });

  it('parses valid HTTPS web URL with centerId and serviceId', () => {
    const input = `https://queueflow.app/join?centerId=${validCenterId}&serviceId=${validServiceId}`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(validCenterId);
    expect(result.serviceId).toBe(validServiceId);
  });

  it('rejects malformed QR with invalid centerId hex characters', () => {
    const input = `queueflow://join?centerId=not-a-valid-mongo-id&serviceId=${validServiceId}`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Invalid Service Center ID format');
  });

  it('rejects malformed QR with invalid serviceId hex characters', () => {
    const input = `queueflow://join?centerId=${validCenterId}&serviceId=xyz123`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Invalid Service ID format');
  });

  it('rejects missing centerId in query params', () => {
    const input = `queueflow://join?serviceId=${validServiceId}`;
    const result = parseJoinUrl(input);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Missing required Service Center ID');
  });

  it('rejects empty, null, or completely unrecognized QR data', () => {
    expect(parseJoinUrl('').isValid).toBe(false);
    expect(parseJoinUrl(null).isValid).toBe(false);
    expect(parseJoinUrl('https://example.com/unrelated').isValid).toBe(false);
  });
});
