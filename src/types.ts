export type Severity = 'Critical' | 'Important' | 'Suggestion';

export interface ReviewFinding {
  severity: Severity;
  path?: string;
  line?: number;
  body: string;
}

export interface ChangedFile {
  path: string;
  additions: Set<number>;
  patch?: string;
}

export interface ReviewDecision {
  event: 'REQUEST_CHANGES' | 'APPROVE';
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  nameWithOwner: string;
}

export interface ReviewRequest {
  id: string;
  marker: string;
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  repository: RepositoryRef;
}

export interface ReviewContext {
  pullRequest: ReviewRequest;
  changedFiles: ChangedFile[];
  issueComments: Array<{ author: string; body: string }>;
  reviews: Array<{ author: string; state: string; body: string }>;
  reviewComments: Array<{ author: string; path: string; line?: number; body: string }>;
  reviewThreads: Array<{
    path: string;
    line?: number;
    isResolved: boolean;
    comments: Array<{ author: string; body: string }>;
  }>;
}

export interface GitHubPort {
  listPersonalReviewRequests(): Promise<ReviewRequest[]>;
  getReviewContext(request: ReviewRequest): Promise<ReviewContext>;
  buildPrompt(context: ReviewContext): string;
  submitReview(request: ReviewRequest, decision: ReviewDecision): Promise<void>;
  hasSubmittedReview?(request: ReviewRequest): Promise<boolean>;
}

export interface PiPort {
  review(prompt: string, options?: { cwd?: string }): Promise<string>;
}

export interface StatePort {
  isHandled(prId: string, marker: string): Promise<boolean>;
  markHandled(prId: string, marker: string): Promise<void>;
}
