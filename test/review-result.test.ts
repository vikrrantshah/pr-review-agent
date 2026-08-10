import { describe, expect, test } from 'vitest';
import { formatReviewDecision, parseReviewResult } from '../src/review-result.js';
import type { ReviewFinding } from '../src/types.js';

const changedFiles = [
  {
    path: 'src/app.ts',
    additions: new Set([10, 11, 12]),
  },
];

describe('review result parsing and decision formatting', () => {
  test('Critical and Important findings request changes with inline comments', () => {
    const findings: ReviewFinding[] = [
      { severity: 'Critical', path: 'src/app.ts', line: 10, body: 'Null dereference can crash production.' },
      { severity: 'Important', path: 'src/app.ts', line: 11, body: 'Authorization check is bypassed.' },
      { severity: 'Suggestion', path: 'src/app.ts', line: 12, body: 'Rename for clarity.' },
    ];

    const decision = formatReviewDecision({ findings, changedFiles });

    expect(decision.event).toBe('REQUEST_CHANGES');
    expect(decision.comments).toEqual([
      { path: 'src/app.ts', line: 10, body: 'Critical: Null dereference can crash production.' },
      { path: 'src/app.ts', line: 11, body: 'Important: Authorization check is bypassed.' },
    ]);
    expect(decision.body).toContain('Suggestions');
    expect(decision.body).toContain('Rename for clarity.');
  });

  test('Important findings no longer block merge but are still posted inline', () => {
    const findings: ReviewFinding[] = [
      { severity: 'Important', path: 'src/app.ts', line: 11, body: 'Authorization check is bypassed.' },
      { severity: 'Suggestion', path: 'src/app.ts', line: 12, body: 'Rename for clarity.' },
    ];

    const decision = formatReviewDecision({ findings, changedFiles });

    expect(decision.event).toBe('APPROVE');
    expect(decision.comments).toEqual([
      { path: 'src/app.ts', line: 11, body: 'Important: Authorization check is bypassed.' },
    ]);
    expect(decision.body.startsWith('LGTM 🚀')).toBe(true);
    expect(decision.body).toContain('Rename for clarity.');
  });

  test('Important findings with invalid anchors approve and are preserved in the body', () => {
    const decision = formatReviewDecision({
      findings: [
        { severity: 'Important', path: 'src/missing.ts', line: 99, body: 'Non-blocking defect without an anchor.' },
      ],
      changedFiles,
    });

    expect(decision.event).toBe('APPROVE');
    expect(decision.comments).toEqual([]);
    expect(decision.body).toContain('Important');
    expect(decision.body).toContain('src/missing.ts:99');
    expect(decision.body).toContain('Non-blocking defect without an anchor.');
  });

  test('invalid anchors are preserved in the body instead of being dropped', () => {
    const decision = formatReviewDecision({
      findings: [
        { severity: 'Critical', path: 'src/missing.ts', line: 99, body: 'This blocker has an invalid anchor.' },
      ],
      changedFiles,
    });

    expect(decision.event).toBe('REQUEST_CHANGES');
    expect(decision.comments).toEqual([]);
    expect(decision.body).toContain('Critical');
    expect(decision.body).toContain('src/missing.ts:99');
    expect(decision.body).toContain('This blocker has an invalid anchor.');
  });

  test('suggestions-only approval begins exactly with LGTM rocket', () => {
    const decision = formatReviewDecision({
      findings: [
        { severity: 'Suggestion', path: 'src/app.ts', line: 10, body: 'Consider simplifying this name.' },
      ],
      changedFiles,
    });

    expect(decision.event).toBe('APPROVE');
    expect(decision.comments).toEqual([]);
    expect(decision.body.startsWith('LGTM 🚀')).toBe(true);
    expect(decision.body).toContain('Consider simplifying this name.');
  });

  test('parses fenced JSON emitted by the toolkit', () => {
    const result = parseReviewResult('before\n```json\n{"findings":[{"severity":"Important","path":"src/app.ts","line":10,"body":"Fix this."}]}\n```\nafter');

    expect(result.findings).toEqual([
      { severity: 'Important', path: 'src/app.ts', line: 10, body: 'Fix this.' },
    ]);
  });

  test('rejects empty Pi output with a clear error', () => {
    expect(() => parseReviewResult('')).toThrow('Pi returned no review output');
  });
});
