import { resolve } from 'node:path';
import type { AuditLog } from './audit.ts';
import { createPullRequest } from './forgejo.ts';
import { Git, GitError } from './git.ts';
import { isProtectedBranch, scanFiles } from './policy.ts';
import type { CommitRequest, CommitResult, Config, RepoStatus } from './types.ts';
import { isValidBranchName, sanitizeBranchSegment } from './util.ts';

export interface ServiceDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const MAX_MESSAGE = 10_000;

/**
 * The only place that mutates a repository. Every request is re-validated
 * against fresh `git status` and policy: the UI is untrusted input.
 */
export class CommitService {
  private readonly cfg: Config;
  private readonly audit: AuditLog;
  private readonly deps: ServiceDeps;
  private readonly busy = new Set<string>();

  constructor(cfg: Config, audit: AuditLog, deps: ServiceDeps = {}) {
    this.cfg = cfg;
    this.audit = audit;
    this.deps = deps;
  }

  git(repo: string): Git {
    return new Git(repo, this.cfg.gitBinary);
  }

  isKnownRepo(repo: string): boolean {
    const r = resolve(repo);
    return this.cfg.repos.some((x) => resolve(x) === r);
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const result = await this.commitInner(req);
    await this.audit.write({
      action: req.push ? 'commit-push' : 'commit',
      repo: req.repo,
      branch: result.branch ?? null,
      result: result.code,
      detail: {
        files: req.files.length,
        commit: result.commit,
        pushed: result.pushed ?? false,
        pr: result.pullRequestUrl,
        findings: result.findings?.map((f) => `${f.rule}:${f.path}${f.line ? `:${f.line}` : ''}`),
      },
    });
    return result;
  }

  private fail(code: CommitResult['code'], message: string, extra: Partial<CommitResult> = {}): CommitResult {
    return { ok: false, code, message, ...extra };
  }

  private async commitInner(req: CommitRequest): Promise<CommitResult> {
    if (!this.isKnownRepo(req.repo)) return this.fail('unknown-repo', 'That repository is not managed by this app.');
    if (this.busy.has(req.repo)) return this.fail('git-error', 'Another save is already running for this repository.');
    this.busy.add(req.repo);
    try {
      return await this.run(req);
    } catch (e) {
      const msg = e instanceof GitError ? e.message : `Unexpected error: ${(e as Error).message}`;
      return this.fail('git-error', msg);
    } finally {
      this.busy.delete(req.repo);
    }
  }

  private async run(req: CommitRequest): Promise<CommitResult> {
    const message = req.message.trim();
    if (!message) return this.fail('empty-message', 'Please describe what you changed.');
    if (message.length > MAX_MESSAGE) return this.fail('empty-message', 'The description is too long.');

    const git = this.git(req.repo);
    const status = await git.status();
    if (status.hasConflicts) {
      return this.fail('conflicts', 'This repository has unresolved merge conflicts. Resolve them first.');
    }

    const changed = new Set(status.files.map((f) => f.path));
    const files = [...new Set(req.files)].filter((f) => changed.has(f));
    if (files.length === 0) return this.fail('no-files', 'None of the selected files have changes any more.');

    // Policy first, before touching the repo, so a blocked save changes nothing.
    const findings = await scanFiles({
      root: req.repo,
      paths: files,
      maxFileBytes: this.cfg.maxFileBytes,
      scanSecrets: this.cfg.scanSecrets,
    });
    const blocks = findings.filter((f) => f.severity === 'block');
    if (blocks.length > 0) {
      const list = [...new Set(blocks.map((f) => `${f.path} (${describeRule(f.rule)})`))].slice(0, 8).join('; ');
      return this.fail('policy-blocked', `Blocked by security policy: ${list}. Remove or exclude these files and try again.`, {
        findings: blocks,
        branch: status.branch ?? undefined,
      });
    }

    const target = await this.resolveBranch(git, status, req);
    if ('error' in target) return target.error;
    const branch = target.branch;

    if (target.create) await git.switchNewBranch(branch);

    await git.unstageAll();
    await git.stage(files);
    let sha: string;
    try {
      sha = await git.commit(message);
    } catch (e) {
      return this.fail('git-error', (e as Error).message, { branch });
    }

    const wantPush = req.push || this.cfg.mode === 'simple';
    if (!wantPush) {
      return { ok: true, code: 'ok', message: `Committed ${files.length} file(s) on ${branch}.`, branch, commit: sha, pushed: false };
    }

    try {
      await git.push(branch);
    } catch (e) {
      return this.fail('push-failed', `Saved locally, but sharing failed: ${(e as Error).message}. Your work is safe; try again later.`, {
        branch,
        commit: sha,
        pushed: false,
      });
    }

    const out: CommitResult = {
      ok: true,
      code: 'ok',
      message: `Committed and pushed ${files.length} file(s) on ${branch}.`,
      branch,
      commit: sha,
      pushed: true,
    };

    const fj = this.cfg.forgejo;
    if (fj?.autoPullRequest && this.cfg.mode === 'simple') {
      const remote = await git.remoteUrl();
      const base = fj.baseBranch ?? (await git.defaultBranch()) ?? 'main';
      if (remote && base !== branch) {
        const pr = await createPullRequest({
          cfg: fj,
          remoteUrl: remote,
          head: branch,
          base,
          title: message.split('\n')[0]!.slice(0, 200),
          body: `${message}\n\n_Opened automatically by auto-push-git-app on behalf of ${this.audit.user}._`,
          env: this.deps.env,
          fetchImpl: this.deps.fetchImpl,
        });
        out.pullRequestUrl = pr.url;
        out.message += ` ${pr.message}`;
        await this.audit.write({ action: 'pull-request', repo: req.repo, branch, result: pr.ok ? 'ok' : 'failed', detail: { url: pr.url } });
      }
    }
    return out;
  }

  /**
   * Decide which branch the commit lands on and whether it must be created.
   * Protected branches are never committed to directly; simple-mode users are
   * always moved onto a personal branch.
   */
  private async resolveBranch(
    git: Git,
    status: RepoStatus,
    req: CommitRequest,
  ): Promise<{ branch: string; create: boolean } | { error: CommitResult }> {
    const current = status.branch;
    const protectedNow = isProtectedBranch(this.cfg.protectedBranches, current);

    if (req.newBranch) {
      const name = req.newBranch.trim();
      if (!isValidBranchName(name)) return { error: this.fail('git-error', `"${name}" is not a valid branch name.`) };
      if (isProtectedBranch(this.cfg.protectedBranches, name)) {
        return { error: this.fail('protected-branch', `"${name}" is a protected branch name.`) };
      }
      if (await git.branchExists(name)) return { error: this.fail('git-error', `Branch "${name}" already exists.`) };
      return { branch: name, create: true };
    }

    if (this.cfg.mode === 'simple') {
      const prefix = `${this.cfg.simpleBranchPrefix}/`;
      if (current && !protectedNow && current.startsWith(prefix)) return { branch: current, create: false };
      const user = sanitizeBranchSegment(this.audit.user);
      const d = (this.deps.now?.() ?? new Date()).toISOString();
      const stamp = d.slice(0, 10).replace(/-/g, '');
      let name = `${prefix}${user}/${stamp}`;
      if (await git.branchExists(name)) name += `-${d.slice(11, 19).replace(/:/g, '')}`;
      return { branch: name, create: true };
    }

    if (protectedNow || !current) {
      return {
        error: this.fail(
          'protected-branch',
          `You are on ${current ? `the protected branch "${current}"` : 'a detached HEAD'}. Choose a new branch name to continue.`,
          { branch: current ?? undefined },
        ),
      };
    }
    return { branch: current, create: false };
  }
}

function describeRule(rule: string): string {
  const map: Record<string, string> = {
    'private-key': 'contains a private key',
    'aws-access-key': 'contains a cloud access key',
    'github-token': 'contains an access token',
    'slack-token': 'contains an access token',
    jwt: 'contains a signed token',
    'basic-auth-url': 'contains a URL with an embedded password',
    'credential-assignment': 'looks like it contains a password or API key',
    'card-number': 'contains a payment card number',
    'env-file': 'environment file',
    'private-key-file': 'key or certificate file',
    'password-store': 'password database',
    'credentials-file': 'credentials file',
    'file-too-large': 'file too large',
  };
  return map[rule] ?? rule;
}
