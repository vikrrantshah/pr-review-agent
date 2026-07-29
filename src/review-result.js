const SEVERITIES = new Set(['Critical', 'Important', 'Suggestion']);
const BLOCKING_SEVERITIES = new Set(['Critical', 'Important']);

export function parseReviewResult(output) {
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error('Pi returned no review output');
  }
  const jsonText = extractJson(output);
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed.findings)) {
    throw new Error('Pi output must contain a findings array');
  }

  return {
    findings: parsed.findings.map((finding, index) => normalizeFinding(finding, index)),
  };
}

export function formatReviewDecision({ findings, changedFiles }) {
  const validAnchors = new Map(changedFiles.map((file) => [file.path, file.additions]));
  const comments = [];
  const bodySections = [];
  const invalidBlockingFindings = [];
  const suggestions = [];

  for (const finding of findings) {
    if (finding.severity === 'Suggestion') {
      suggestions.push(finding);
      continue;
    }

    if (isValidAnchor(finding, validAnchors)) {
      comments.push({
        path: finding.path,
        line: finding.line,
        body: `${finding.severity}: ${finding.body}`,
      });
    } else {
      invalidBlockingFindings.push(finding);
    }
  }

  if (invalidBlockingFindings.length > 0) {
    bodySections.push(['Blocking findings without valid inline anchors:', ...invalidBlockingFindings.map(formatFindingForBody)].join('\n'));
  }

  if (suggestions.length > 0) {
    bodySections.push(['Suggestions:', ...suggestions.map(formatFindingForBody)].join('\n'));
  }

  const hasBlockers = comments.length > 0 || invalidBlockingFindings.length > 0;
  if (hasBlockers) {
    const body = bodySections.length > 0 ? bodySections.join('\n\n') : 'Requesting changes for the inline Critical/Important findings.';
    return { event: 'REQUEST_CHANGES', body, comments };
  }

  const approvalBody = bodySections.length > 0 ? `LGTM 🚀\n\n${bodySections.join('\n\n')}` : 'LGTM 🚀';
  return { event: 'APPROVE', body: approvalBody, comments: [] };
}

function extractJson(output) {
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    return fence[1].trim();
  }

  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return output.slice(start, end + 1);
  }

  return output.trim();
}

function normalizeFinding(finding, index) {
  if (!finding || typeof finding !== 'object') {
    throw new Error(`Finding ${index + 1} must be an object`);
  }
  if (!SEVERITIES.has(finding.severity)) {
    throw new Error(`Finding ${index + 1} has invalid severity`);
  }
  if (typeof finding.body !== 'string' || finding.body.trim().length === 0) {
    throw new Error(`Finding ${index + 1} must include a body`);
  }

  return {
    severity: finding.severity,
    path: typeof finding.path === 'string' ? finding.path : undefined,
    line: Number.isInteger(finding.line) ? finding.line : undefined,
    body: finding.body.trim(),
  };
}

function isValidAnchor(finding, validAnchors) {
  if (!BLOCKING_SEVERITIES.has(finding.severity) || !finding.path || !Number.isInteger(finding.line)) {
    return false;
  }
  return validAnchors.get(finding.path)?.has(finding.line) === true;
}

function formatFindingForBody(finding) {
  const location = finding.path && Number.isInteger(finding.line) ? `${finding.path}:${finding.line}` : 'unanchored';
  return `- ${finding.severity} (${location}): ${finding.body}`;
}
