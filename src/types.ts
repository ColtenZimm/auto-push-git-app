export type Mode = 'developer' | 'simple';

export interface ForgejoConfig {
  /** Base URL of the Forgejo instance, e.g. https://git.corp.example */
  url: string;
  /** Name of the environment variable holding an access token. */
  tokenEnv: string;
  /** Optional file containing an access token (first line). Used if env var is unset. */
  tokenFile?: string;
  /** PR target branch. If omitted, origin's default branch is used. */
  baseBranch?: string;
  /** Open a pull request automatically after a successful push (simple mode). */
  autoPullRequest: boolean;
}

export interface Config {
  repos: string[];
  mode: Mode;
  debounceMs: number;
  pollIntervalMs: number;
  snoozeMinutes: number[];
  protectedBranches: string[];
  simpleBranchPrefix: string;
  maxFileBytes: number;
  scanSecrets: boolean;
  forgejo?: ForgejoConfig;
  auditLogPath: string;
  gitBinary: string;
  ignoreDirs: string[];
  ui: { port: number; openPopup: boolean };
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface FileChange {
  path: string;
  kind: ChangeKind;
  staged: boolean;
}

export interface RepoStatus {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileChange[];
  hasConflicts: boolean;
}

export interface PromptSnapshot {
  id: string;
  repo: string;
  repoName: string;
  branch: string | null;
  branchProtected: boolean;
  mode: Mode;
  files: FileChange[];
  ahead: number;
  createdAt: number;
}

export interface CommitRequest {
  repo: string;
  message: string;
  files: string[];
  push: boolean;
  /** Create and switch to this branch before committing. */
  newBranch?: string;
}

export interface CommitResult {
  ok: boolean;
  code:
    | 'ok'
    | 'empty-message'
    | 'no-files'
    | 'protected-branch'
    | 'policy-blocked'
    | 'conflicts'
    | 'git-error'
    | 'push-failed'
    | 'unknown-repo';
  message: string;
  branch?: string;
  commit?: string;
  pushed?: boolean;
  pullRequestUrl?: string;
  findings?: PolicyFinding[];
}

export interface PolicyFinding {
  path: string;
  rule: string;
  line?: number;
  severity: 'block' | 'warn';
}
