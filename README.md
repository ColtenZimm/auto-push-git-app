# auto-push-git-app

A small background service that watches your working repositories and, when you
have unsaved work, pops up a window asking you to **commit and push it**, with
guard rails suited to an on-prem fintech environment:

- never commits to protected branches (`main`, `release/*`, ...)
- blocks secrets, keys, `.env` files, payment card numbers and oversized files
- optionally opens a **Forgejo pull request** for you
- writes an audit trail
- two audiences from one codebase: **developer mode** (git vocabulary) and
  **simple mode** (plain language, personal branch, auto pull request)

Runs on **Windows and Linux**, has **zero runtime dependencies**, and uses the
real `git` CLI, so your existing SSH keys / Git Credential Manager / libsecret
setup keeps working. The app never sees or stores a password.

## Requirements

- Node.js **22.18+** (runs the TypeScript sources directly; no build step)
- `git` on `PATH`
- Microsoft Edge or Chrome/Chromium for the popup window (falls back to the default browser)

## Quick start

```bash
npm install            # dev tooling only (typescript, @types/node)
npm test               # 29 tests, real git repos + a bare remote
node src/cli.ts status --repo /path/to/repo
node src/cli.ts run --repo /path/to/repo
```

Edit a file in that repo, wait ~5 seconds, and the popup appears.

## How it works

```
 file events ──► RepoMonitor ──► (debounce) ──► `git status` ──► anti-nag rules ──► "prompt"
 poll timer ──►                                                                         │
                                                                                        ▼
                                  popup window ◄── local UI server (127.0.0.1, token) ──┘
                                        │ commit / snooze / dismiss
                                        ▼
                                  CommitService ── policy scan ── git add/commit/push ── Forgejo PR
                                        │
                                        ▼
                                    audit log (JSONL)
```

| File | Responsibility |
|---|---|
| `src/monitor.ts` | Decides *when* to ask: debounce, confirm with git, one prompt per batch, dismiss / snooze / pause |
| `src/service.ts` | The only code that changes a repo. Re-validates every request against fresh status and policy |
| `src/policy.ts` | Protected branches, blocked filenames, size limit, secret and card-number detection |
| `src/git.ts` | `execFile` wrapper around git (never a shell), porcelain-v2 parser, prompts disabled |
| `src/forgejo.ts` | Opens PRs; sends the token only to the configured host |
| `src/server.ts` + `public/` | Loopback UI backend and the popup page |
| `src/config.ts` | Layered, strictly validated configuration |
| `src/audit.ts` | Append-only JSONL audit trail |

### Anti-nag rules

A popup on every save would train people to click through. So:

1. File events only *hint*. After a quiet period the app asks `git status` whether anything is really uncommitted.
2. One prompt per batch of changes. Further edits refresh the open prompt instead of opening another.
3. **Not now** stays quiet until the changed files differ. **Remind me in...** re-asks after the chosen time if still dirty.
4. A poll timer (default 60 s) covers network shares and missed events.

### Modes

| | developer | simple |
|---|---|---|
| Wording | commit, push, branch | "Save and share" |
| Branch | current branch; protected branches require choosing a new one | always a personal branch `users/<name>/<yyyymmdd>` |
| Push | optional (**Commit** vs **Commit & push**) | always |
| After push | nothing | Forgejo PR opened automatically (if configured) |

## Configuration

Layers, later wins: **defaults < user file < `$AUTOPUSH_CONFIG` < managed (IT) file**.

| | Windows | Linux |
|---|---|---|
| user | `%APPDATA%\autopush\config.json` | `~/.config/autopush/config.json` |
| managed | `%ProgramData%\autopush\config.json` | `/etc/autopush/config.json` |

Because the managed file is applied last, **users cannot loosen policy locally**
(protected branches, secret scanning, size limit). Unknown keys or bad values
are rejected at startup with a clear error. See [`config/`](config) for examples
and run `node src/cli.ts check-config` to print the effective result.

| Key | Default | Meaning |
|---|---|---|
| `repos` | `[]` | Absolute paths of repositories to watch |
| `mode` | `developer` | `developer` or `simple` |
| `debounceMs` | `5000` | Quiet period after the last file event |
| `pollIntervalMs` | `60000` | Fallback status poll |
| `snoozeMinutes` | `[15,60,240]` | Choices offered in the popup |
| `protectedBranches` | `main, master, release/*, prod, production` | Globs; never committed to or pushed directly |
| `simpleBranchPrefix` | `users` | Prefix for simple-mode branches |
| `maxFileBytes` | `5242880` | Larger files are refused |
| `scanSecrets` | `true` | Scan content for keys, tokens, passwords, card numbers |
| `forgejo.url` | none | e.g. `https://git.corp.example` |
| `forgejo.tokenEnv` / `tokenFile` | `FORGEJO_TOKEN` | Where the API token comes from (PR creation only) |
| `forgejo.autoPullRequest` | `true` | Open a PR after a simple-mode push |
| `auditLogPath` | per-user state dir | JSONL audit file |

## Security model

- **No credential handling.** git authenticates through its own helpers. `GIT_TERMINAL_PROMPT=0` means a headless run can never hang on a prompt. The only secret the app reads is the optional Forgejo API token (env var or file), used solely for PR creation.
- **Token exfiltration guard.** The token is sent only if the repo's `origin` host equals the configured Forgejo host.
- **Local UI hardening.** Bound to `127.0.0.1`; random per-run token on every API call; Host and Origin validation (blocks DNS rebinding and cross-site requests); JSON-only POSTs; strict CSP; the popup renders all repo data with `textContent`. The repo targeted by an action comes from the server-side prompt, never from the client.
- **Policy before action.** A blocked save changes nothing in the repository. Findings name the file and rule but never echo the matched secret, in the UI or the audit log.
- **Only selected files are committed.** The index is rebuilt from exactly the files ticked in the popup. Anything you had pre-staged but did not tick is **unstaged** (kept in the working tree), so partial hunk staging is not preserved.
- **Audit trail.** One JSON line per prompt, commit, push, PR and policy block, with user, repo, branch and result (no file contents).

> Client-side checks are a safety net, not enforcement. Keep **branch protection
> and required reviews on the Forgejo server** as the real control.

## Deployment

**Windows** (per-user, starts at logon): see [`packaging/windows`](packaging/windows).
**Linux** (systemd user service): see [`packaging/linux`](packaging/linux).
Push the managed config with GPO/Intune (`%ProgramData%`) or Ansible/Puppet (`/etc/autopush`).
Forward `audit.jsonl` with your existing log shipper.

Linux notes: raise `fs.inotify.max_user_watches` for large repos. Repos on
network shares rely on the poll timer rather than file events.

## Known limitations / next steps

- **No tray icon yet.** The popup is a standalone app window, and the service runs headless. A thin Tauri or Avalonia shell (tray, pause toggle, native toast) can sit in front of this engine without changing it.
- Requires Node on each machine. Package as a single executable (`node --experimental-sea-config` / Node SEA) or ship a pinned Node with your installer if you cannot assume it.
- Installer scripts (systemd unit, Windows scheduled task) are provided but have **not been exercised on a real fleet**; test them on a pilot group first.
- **CI is not active yet.** The workflow lives at `packaging/ci/github-actions-ci.yml` because the token used to push this repo lacked GitHub's `workflow` scope. Copy it to `.github/workflows/ci.yml` (or adapt it to Forgejo Actions under `.forgejo/workflows/`) to enable typecheck + tests on Linux and Windows.
- Secret scanning is pattern based. Run a server-side scanner (e.g. gitleaks in Forgejo Actions) as well.
- Popup is English only.
