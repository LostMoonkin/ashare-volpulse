export const DEFAULT_API_BASE_URL: string;
export const DEFAULT_CONFIG_FILENAME: string;
export const GITHUB_API_VERSION: string;
export const USER_AGENT: string;

export interface BotConfig {
  configPath: string;
  owner: string;
  repo: string;
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface ResolveConfigOptions {
  configPath?: string;
  rootDir?: string;
  env?: Record<string, string | undefined>;
}

export interface AppIdentity {
  id: number;
  slug: string;
  name: string;
  botLogin: string;
  htmlUrl: string;
}

export interface InstallationTokenResult {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection: string;
}

export interface RepoMetadata {
  fullName: string;
  private: boolean;
  htmlUrl: string;
  openIssuesCount: number;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface IssueComment {
  id: number;
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  user?: {
    login: string;
  };
}

export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
}

export interface PostedCommentResult {
  id: number;
  htmlUrl: string;
  author: string;
  createdAt: string;
}

export interface ParsedCliArgs {
  command: string;
  configPath?: string;
  json?: boolean;
  dryRun?: boolean;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  label?: string;
  needsReply?: boolean;
  issueNumber?: number | null;
  body?: string;
  hasBody?: boolean;
  bodyFile?: string;
  stdin?: boolean;
  addLabels?: string[];
  removeLabel?: string;
}

export type FetchLike = typeof fetch;

export function base64UrlEncode(input: Buffer | string): string;

export function createAppJwt(
  appId: string | number,
  privateKeyPem: string,
  nowSeconds?: number,
): string;

export function parseRepoSlug(raw: string): { owner: string; repo: string };

export function sanitizeErrorMessage(message: string, secrets?: readonly string[]): string;

export function resolveConfig(options?: ResolveConfigOptions): BotConfig;

export function filterRealIssues<T extends { pull_request?: unknown }>(items: readonly T[]): T[];

export function needsBotReply(
  issue: unknown,
  comments: ReadonlyArray<{ user?: { login?: string | null } | null }>,
  botLogin: string,
  ownerLogin: string,
): boolean;

export function fetchAppIdentity(options: {
  appId: string | number;
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<AppIdentity>;

export function exchangeInstallationToken(options: {
  appId: string | number;
  installationId: string | number;
  privateKeyPem: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<InstallationTokenResult>;

export function fetchRepoMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<RepoMetadata>;

export function listIssues(options: {
  token: string;
  owner: string;
  repo: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  label?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<IssueSummary[]>;

export function listIssueComments(options: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<IssueComment[]>;

export function getIssueDetail(options: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<IssueDetail>;

export function postIssueComment(options: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<PostedCommentResult>;

export function addIssueLabels(options: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  labels: readonly string[];
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string[]>;

export function removeIssueLabel(options: {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  label: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string[]>;

export function parseCliArgs(argv?: readonly string[]): ParsedCliArgs;
