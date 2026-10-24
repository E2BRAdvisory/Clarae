import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { problem, renderApp } from '../test/utils';

const GB = 1024 ** 3;

function usage(used: number, quota: number) {
  return { 'GET /me/usage': { used_bytes: used, quota_bytes: quota, level: 'ok' } };
}

describe('usage page', () => {
  it('shows the bar with used and quota', async () => {
    renderApp({ path: '/usage', routes: usage(1 * GB, 4 * GB) });
    expect(await screen.findByText('1 GB of 4 GB')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'ok');
  });

  it.each([
    [85, 'warn', /more than 80%/],
    [96, 'critical', /more than 95%/],
    [100, 'full', /space is full/],
  ])('at %d%% the level is %s and the message says so', async (pct, level, message) => {
    renderApp({ path: '/usage', routes: usage(pct, 100) });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', level);
  });

  it('handles an unlimited quota', async () => {
    renderApp({ path: '/usage', routes: usage(2 * GB, -1) });
    expect(await screen.findByText('2 GB used, no limit')).toBeInTheDocument();
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'ok');
  });

  it('shows the API error with a retry button', async () => {
    renderApp({ path: '/usage', routes: { 'GET /me/usage': () => problem(403, 'FORBIDDEN') } });
    expect(await screen.findByRole('alert')).toHaveTextContent('You are not allowed to do this.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
