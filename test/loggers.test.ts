import { describe, expect, test } from 'vitest';
import { createLogger, formatPrettyEvent, formatStartup, formatSummary } from '../src/loggers.js';

describe('pretty logger', () => {
  test('renders the active PR as a terminal card', () => {
    const output = formatPrettyEvent({
      timestamp: '2026-07-16T12:30:21.729Z',
      event: 'review_started',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
    });

    expect(output).toContain('REVIEWING acme/a#42');
    expect(output).toContain('Started: Jul 16, 2026, 12:30:21 PM UTC');
    expect(output).toContain('Title: Fix checkout flow');
    expect(output).toContain('URL:   https://github.com/acme/a/pull/42');
  });

  test('renders the PR author and humanized age, keeping size out of the card', () => {
    const output = formatPrettyEvent({
      timestamp: '2026-07-16T12:30:21.729Z',
      event: 'review_started',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      author: 'kerrin',
      requestedAt: '2026-07-13T08:30:21.729Z',
      additions: 120,
      deletions: 30,
      changedFiles: 5,
    });

    expect(output).toContain('Author: @kerrin');
    expect(output).toContain('Age: waiting 3d 4h');
    expect(output).not.toContain('120');
    expect(output).not.toContain('changedFiles');
  });

  test('omits the age line when the requested-at time is unavailable', () => {
    const output = formatPrettyEvent({
      timestamp: '2026-07-16T12:30:21.729Z',
      event: 'review_failed',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      author: 'kerrin',
      error: 'boom',
    });

    expect(output).toContain('Author: @kerrin');
    expect(output).not.toContain('Age:');
  });

  test('humanizes shorter waiting times', () => {
    const base = {
      timestamp: '2026-07-16T12:30:21.729Z',
      event: 'review_started',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      author: 'kerrin',
    };

    expect(formatPrettyEvent({ ...base, requestedAt: '2026-07-16T10:30:21.729Z' })).toContain('Age: waiting 2h');
    expect(formatPrettyEvent({ ...base, requestedAt: '2026-07-16T12:05:21.729Z' })).toContain('Age: waiting <1h');
  });

  test('renders review outcome counts and action', () => {
    const output = formatPrettyEvent({
      timestamp: '2026-07-16T12:35:21.729Z',
      event: 'review_completed',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      critical: 1,
      important: 2,
      suggestions: 3,
      commentsPosted: 4,
      action: 'request_changes',
    });

    expect(output).toContain('REQUEST CHANGES acme/a#42');
    expect(output).toContain('Requested changes: Jul 16, 2026, 12:35:21 PM UTC');
    expect(output).toContain('Critical: 1');
    expect(output).toContain('Important: 2');
    expect(output).toContain('Suggestions: 3');
    expect(output).toContain('Comments posted: 4');
  });

  test('renders approval time with the approved label', () => {
    const output = formatPrettyEvent({
      timestamp: '2026-07-16T12:40:21.729Z',
      event: 'review_completed',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      critical: 0,
      important: 0,
      suggestions: 0,
      commentsPosted: 0,
      action: 'approved',
    });

    expect(output).toContain('Approved: Jul 16, 2026, 12:40:21 PM UTC');
  });

  test('renders multiline errors inside the terminal card', () => {
    const output = formatPrettyEvent({
      event: 'review_failed',
      repo: 'acme/a',
      number: 42,
      title: 'Fix checkout flow',
      url: 'https://github.com/acme/a/pull/42',
      error: 'first line\nsecond line\nthird line',
    });

    expect(output).toContain('│ Error: first line');
    expect(output).toContain('│ second line');
    expect(output).toContain('│ third line');
  });

  test('renders startup and tick summaries', () => {
    expect(formatStartup({ intervalMs: 60_000, concurrency: 3, dryRun: false, logFormat: 'pretty' })).toContain('pr-review-agent');
    expect(formatSummary({ reviewed: 2, skipped: 1, failed: 0, overlapped: false })).toContain('Reviewed: 2');
  });
});

describe('json logger', () => {
  test('keeps machine-readable JSON lines available', () => {
    const lines: string[] = [];
    const logger = createLogger({ format: 'json', stream: { write: (line: string) => { lines.push(line); } } });

    logger.logEvent({ event: 'review_started', repo: 'acme/a', number: 42 });

    expect(lines).toEqual(['{"event":"review_started","repo":"acme/a","number":42}\n']);
  });
});
