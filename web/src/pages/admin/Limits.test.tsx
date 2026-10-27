import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { problem, renderApp, type RecordedCall } from '../../test/utils';
import { validateLimits } from './LimitsPage';

const ADMIN = { roles: ['memobrain-admin'] };
const GB = 1024 ** 3;
const settings = {
  default_quota_bytes: 5 * GB,
  warn_percent: 80,
  critical_percent: 95,
  history_retention_days: 30,
  history_daily_retention_days: 90,
  max_file_size_bytes: 100 * 1024 ** 2,
};

describe('validateLimits', () => {
  const form = (over: Partial<Record<string, string>> = {}) => ({
    quota: { value: '5', unit: 'GB' as const },
    warn: over['warn'] ?? '80',
    critical: over['critical'] ?? '95',
    retention: over['retention'] ?? '30',
    daily: over['daily'] ?? '90',
    maxFile: { value: over['maxFile'] ?? '100', unit: 'MB' as const },
  });
  it('accepts the server rules and converts units', () => {
    expect(validateLimits(form()).value).toEqual(settings);
  });
  it.each([
    [{ warn: '95', critical: '95' }, 'warnRange'],
    [{ warn: '0' }, 'warnRange'],
    [{ critical: '101' }, 'warnRange'],
    [{ warn: 'x' }, 'percents'],
    [{ retention: '0' }, 'retention'],
    [{ daily: '10' }, 'dailyLess'],
    [{ maxFile: '0.0005' }, 'maxFileMin'],
  ])('rejects %j with %s', (over, key) => {
    const r = validateLimits(form(over));
    expect(r.value).toBeUndefined();
    expect(r.errors).toHaveProperty(key);
  });
});

describe('limits page', () => {
  it('loads the settings with unit-aware inputs and saves converted values', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/limits',
      user: ADMIN,
      routes: {
        'GET /admin/settings/storage': settings,
        'PUT /admin/settings/storage': (c: RecordedCall) => c.body,
        'GET /admin/storage/overview': {},
      },
    });
    const quota = await screen.findByLabelText('Default quota per user');
    expect(quota).toHaveValue(5);
    expect(screen.getByLabelText('Unit of Default quota per user')).toHaveValue('GB');
    expect(screen.getByLabelText('Unit of Maximum file size')).toHaveValue('MB');
    fireEvent.change(quota, { target: { value: '10' } });
    await user.selectOptions(screen.getByLabelText('Unit of Maximum file size'), 'GB');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(api.called('PUT', '/admin/settings/storage')).toHaveLength(1));
    expect(api.called('PUT', '/admin/settings/storage')[0]?.body).toEqual({
      ...settings,
      default_quota_bytes: 10 * GB,
      max_file_size_bytes: 100 * GB,
    });
    expect(await screen.findByText('Limits saved.')).toBeInTheDocument();
  });

  it('blocks invalid input client-side and shows server validation errors', async () => {
    const user = userEvent.setup();
    const { api } = renderApp({
      path: '/admin/limits',
      user: ADMIN,
      routes: {
        'GET /admin/settings/storage': settings,
        'PUT /admin/settings/storage': problem(
          400,
          'VALIDATION_FAILED',
          'critical_percent must be greater than warn_percent',
        ),
      },
    });
    const warn = await screen.findByLabelText('Warning level (%)');
    fireEvent.change(warn, { target: { value: '99' } });
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(
      await screen.findByText(/warning level must be at least 1 and lower than the critical level/),
    ).toBeInTheDocument();
    expect(api.called('PUT', '/admin/settings/storage')).toHaveLength(0);

    fireEvent.change(warn, { target: { value: '70' } });
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(
      await screen.findByText(/critical_percent must be greater than warn_percent/),
    ).toBeInTheDocument();
    expect(api.called('PUT', '/admin/settings/storage')).toHaveLength(1);
  });
});
