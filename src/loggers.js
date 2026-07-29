const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const ACTION_LABELS = {
  approved: 'APPROVED',
  request_changes: 'REQUEST CHANGES',
  would_approve: 'WOULD APPROVE',
  would_request_changes: 'WOULD REQUEST CHANGES',
};

export function createLogger({ format = 'pretty', stream = process.stdout, color = false } = {}) {
  return format === 'json' ? new JsonLogger(stream) : new PrettyLogger(stream, { color });
}

class JsonLogger {
  constructor(stream) {
    this.stream = stream;
  }

  logEvent(event) {
    this.stream.write(`${JSON.stringify(event)}\n`);
  }

  logText(text) {
    this.stream.write(`${text}\n`);
  }
}

class PrettyLogger {
  constructor(stream, { color }) {
    this.stream = stream;
    this.color = color;
  }

  logEvent(event) {
    this.stream.write(`${formatPrettyEvent(event, { color: this.color })}\n`);
  }

  logText(text) {
    this.stream.write(`${text}\n`);
  }
}

export function formatStartup({ intervalMs, concurrency, dryRun, logFormat }) {
  return card('pr-review-agent', [
    `Polling:     every ${intervalMs}ms`,
    `Concurrency: ${concurrency}`,
    `Mode:        ${dryRun ? 'dry-run' : 'live'}`,
    `Logs:        ${logFormat}`,
  ]);
}

export function formatSummary(summary) {
  return card('TICK COMPLETE', [
    `Reviewed: ${summary.reviewed}`,
    `Skipped:  ${summary.skipped}`,
    `Failed:   ${summary.failed}`,
    `Overlap:  ${summary.overlapped ? 'yes' : 'no'}`,
  ]);
}

export function formatPrettyEvent(event, { color = false } = {}) {
  if (event.event === 'review_started') {
    return card(formatHeading(`REVIEWING ${prLabel(event)}`, 'cyan', color), [
      ...timeLines('Started', event.timestamp),
      `Title: ${event.title}`,
      `URL:   ${event.url}`,
    ]);
  }

  if (event.event === 'review_completed') {
    return card(formatHeading(`${ACTION_LABELS[event.action] ?? event.action.toUpperCase()} ${prLabel(event)}`, actionColor(event.action), color), [
      ...timeLines(completionTimeLabel(event.action), event.timestamp),
      `Title: ${event.title}`,
      `Critical: ${event.critical}`,
      `Important: ${event.important}`,
      `Suggestions: ${event.suggestions}`,
      `Comments posted: ${event.commentsPosted}`,
      `URL: ${event.url}`,
    ]);
  }

  if (event.event === 'review_failed') {
    return card(formatHeading(`FAILED ${prLabel(event)}`, 'red', color), [
      `Title: ${event.title}`,
      `Error: ${event.error}`,
      `URL:   ${event.url}`,
    ]);
  }

  if (event.event === 'review_skipped') {
    return card(formatHeading(`SKIPPED ${prLabel(event)}`, 'yellow', color), [
      `Title:  ${event.title}`,
      `Reason: ${event.reason}`,
      `URL:    ${event.url}`,
    ]);
  }

  if (event.event === 'poll_failed') {
    return card(formatHeading('POLL FAILED', 'red', color), [`Error: ${event.error}`]);
  }

  return card(event.event.toUpperCase(), Object.entries(event).map(([key, value]) => `${key}: ${value}`));
}

function prLabel(event) {
  return `${event.repo}#${event.number}`;
}

function card(title, lines) {
  const body = lines.flatMap(cardLines).map((line) => `│ ${line}`).join('\n');
  return `╭─ ${title}\n${body}\n╰${'─'.repeat(72)}`;
}

function cardLines(line) {
  return String(line).replace(ANSI_PATTERN, '').split('\n');
}

function actionColor(action) {
  return action === 'approved' || action === 'would_approve' ? 'green' : 'yellow';
}

function timeLines(label, timestamp) {
  return timestamp ? [`${label}: ${formatPrettyTime(timestamp)}`] : [];
}

function formatPrettyTime(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
}

function completionTimeLabel(action) {
  if (action === 'request_changes') return 'Requested changes';
  if (action === 'would_approve') return 'Would approve';
  if (action === 'would_request_changes') return 'Would request changes';
  return 'Approved';
}

function formatHeading(text, colorName, enabled) {
  if (!enabled) return text;
  const colors = {
    cyan: '\u001b[36m',
    green: '\u001b[32m',
    red: '\u001b[31m',
    yellow: '\u001b[33m',
  };
  return `${colors[colorName] ?? ''}${text}\u001b[0m`;
}
