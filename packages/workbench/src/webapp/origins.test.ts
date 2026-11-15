import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  confirmOrigin,
  confirmedOrigins,
  forgetOrigins,
  isOriginConfirmed,
  useOriginConfirmed,
} from './origins';

beforeEach(() => {
  localStorage.clear();
  forgetOrigins('v1');
  forgetOrigins('v2');
});

describe('confirmed origins', () => {
  it('are kept per vault, on this device', () => {
    expect(isOriginConfirmed('v1', 'https://example.com')).toBe(false);
    confirmOrigin('v1', 'https://example.com');
    expect(isOriginConfirmed('v1', 'https://example.com')).toBe(true);
    expect(isOriginConfirmed('v1', 'https://example.org')).toBe(false);
    expect(isOriginConfirmed('v2', 'https://example.com')).toBe(false);
    expect(localStorage.getItem('clarae.webapp.origins.v1')).toBe('["https://example.com"]');
  });

  it('are not repeated', () => {
    confirmOrigin('v1', 'https://example.com');
    confirmOrigin('v1', 'https://example.com');
    expect(confirmedOrigins('v1')).toEqual(['https://example.com']);
  });

  it('are forgotten together', () => {
    confirmOrigin('v1', 'https://example.com');
    confirmOrigin('v1', 'https://example.org');
    confirmOrigin('v2', 'https://example.com');
    forgetOrigins('v1');
    expect(confirmedOrigins('v1')).toEqual([]);
    expect(localStorage.getItem('clarae.webapp.origins.v1')).toBeNull();
    expect(isOriginConfirmed('v2', 'https://example.com')).toBe(true);
  });

  it('survive a damaged entry', () => {
    localStorage.setItem('clarae.webapp.origins.v1', '{not json');
    expect(isOriginConfirmed('v1', 'https://example.com')).toBe(false);
    localStorage.setItem('clarae.webapp.origins.v1', '"text"');
    expect(confirmedOrigins('v1')).toEqual([]);
    localStorage.setItem('clarae.webapp.origins.v1', '["https://a.test", 7, null]');
    expect(confirmedOrigins('v1')).toEqual(['https://a.test']);
  });

  it('re-render the component that shows them', () => {
    const { result } = renderHook(() => useOriginConfirmed('v1', 'https://example.com'));
    expect(result.current).toBe(false);
    act(() => confirmOrigin('v1', 'https://example.com'));
    expect(result.current).toBe(true);
    act(() => forgetOrigins('v1'));
    expect(result.current).toBe(false);
  });
});
