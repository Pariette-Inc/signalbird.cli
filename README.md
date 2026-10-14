# signalbird-cli

The command line tool for [Signalbird](https://signalbird.io). One package, three jobs:

| Role | What it does | Where it runs |
| --- | --- | --- |
| **Janet** (`signalbird login`, `signalbird fix …`) | Takes an alert from Signalbird Radio, hands it to the AI agent on your computer (Claude Code, Codex or Gemini CLI), and opens a pull request with the fix. You review and merge. | Your development machine |
| **Sender** (`signalbird send …`) | Writes a single event to a Radio channel from a deploy script, a cron job or any shell. | Anywhere |
| **Server agent** (`signalbird agent …`) | Reports load, memory, disk, services, databases and log lines to the Servers screen. Receives no commands. | Your Linux server (root) |

[Türkçe README](README.tr.md) · [Documentation](https://signalbird.io/en/sdk/cli) · [Protocol](PROTOCOL.md) · MIT

```bash
npm i -g signalbird-cli
signalbird --version
```

Requires **Node.js 20+**. The package never updates itself; to upgrade, run the same `npm i -g signalbird-cli` again.

> The CLI prints its messages in Turkish. Command names, flags and exit codes are the same in every language.

---

## Janet: fixes Radio alerts and opens a PR

You do two things once on your computer. Everything after that happens in the Signalbird panel.

```bash
npm i -g signalbird-cli
signalbird login
```

`signalbird login` walks through four steps:

1. **Project folder.** Finds the folder your projects live in (for example `~/git`) or asks for it. Every folder below it is a project: `~/git/adall` holds `adall.api`, `adall.web`, `app.adall`. Only folder and repository **names** go to Signalbird, never paths.
2. **Account.** Opens your browser; you click **Connect this computer** while signed in to Signalbird. No key to copy. The computer belongs to **your account** and can take Janet jobs from every team you are a member of.
3. **Checks.** git, `gh` and your AI agent (Claude Code, Codex or Gemini CLI), including whether its session actually works.
4. **Service.** Installs a background service (launchd on macOS, `systemd --user` on Linux) that starts with the computer.

Then, in the panel under **Integrations → Janet**:

- **Projects:** `adall.io → adall` style matches are usually found on their own. If one is wrong, pick the right folder from the list.
- Turn on **Janet fixes automatically** for a Radio channel, or press **Send to Janet** on a single alert.
- Talk to Janet on the job page. Janet can ask you a question when the alert is ambiguous; the job waits for your answer.
- Press **Resolved** when you are done. The local clone is deleted.

### How a job runs

1. An alert arrives. Each repository of the project is cloned with `git clone --shared` into `~/.signalbird/fix/jobs/SBF-…/` on a new `janet/SBF-…` branch. Your working copy is never touched and the clone does not show up in your editor.
2. The agent reads the alert, the conversation so far and every repository, decides where the problem is and commits the fix. The alert text sits in a separate block marked as untrusted data, not instructions.
3. Repositories without changes are removed right away. Changed ones are pushed and a pull request is opened for each.
4. The panel shows the live log, Janet's summary and the PR links. If Janet needs more information, the job moves to **Waiting for you**.
5. **Resolved**, **Reject** or **Stop** deletes the local clone. Writing to Janet on an open job continues on the same branch and the same PR.

### AI agent: Claude Code, Codex or Gemini CLI

Janet does not write the code itself; it runs the AI agent on your computer. Three are supported:

| Agent | Install | Sign in |
| --- | --- | --- |
| `claude` · Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude setup-token`, then `signalbird fix claude-token` |
| `codex` · Codex (ChatGPT) | `npm i -g @openai/codex` | `codex login` (with your ChatGPT account) or `CODEX_API_KEY` via `--key` |
| `gemini` · Gemini CLI | `npm i -g @google/gemini-cli` | Google sign-in via `gemini`, or `GEMINI_API_KEY` via `--key`; Workspace accounts add `--env GOOGLE_CLOUD_PROJECT=<project>` |

`signalbird login` picks the one that is installed (order: claude, codex, gemini). To switch:

```bash
signalbird fix agent            # which one is selected, which are installed
signalbird fix agent codex      # tests it, saves it, restarts the service
signalbird fix agent gemini --key AIza…
```

**Why is Janet free?** Because the AI runs on your computer with your own account: your Claude, ChatGPT or Gemini subscription. Signalbird makes no AI calls and does not cover their cost or limits. Usage fees and limits are between you and your agent's provider; if the limit is hit, Janet stops sending jobs to that computer for 30 minutes.

### Janet commands

| Command | |
| --- | --- |
| `signalbird login [--root ~/git] [--agent claude\|codex\|gemini] [--no-service] [--api URL]` | Connects this computer with your account (browser approval), finds the project folder, installs the service. Run it once. |
| `signalbird logout` | Removes this computer's session and its service. |
| `signalbird fix status` | Service, connection, selected agent and open job folders. |
| `signalbird fix doctor` | Checks git, gh, the selected agent (including the session) and the API; clears a stale "sign in" flag once the agent works again. |
| `signalbird fix agent [claude\|codex\|gemini] [--key …] [--env NAME=value]` | Shows or switches the AI agent Janet uses (tests it, saves it, restarts the service). |
| `signalbird fix claude-token [token]` | Connects Janet to Claude with a long-lived token from `claude setup-token`. Pasting works even when the terminal splits the token over two lines. |
| `signalbird fix links` | Local links and the projects found under your folder. |
| `signalbird fix link <domain\|#channel> <folder> [--base branch] [--repos a,b]` | Pins a domain or channel to a folder on this computer. Overrides the panel's automatic match. |
| `signalbird fix unlink <domain\|#channel>` | Removes a local link. |
| `signalbird fix install` | Installs (or restarts) the background service. Run it after upgrading the package. |
| `signalbird fix uninstall` | Removes the service. |
| `signalbird fix start` | Runs in the foreground instead of the service. |
| `signalbird fix logs [-n 100]` | The end of the service log. |
| `signalbird fix cleanup [--dry-run] [--force]` | Deletes local clones of jobs that are already closed on the server. |
| `signalbird fix login --key sbf_live_… [--api URL]` | Advanced: connects with a team key instead of your account. |

**Target branch.** `--base` first, then the first branch that exists out of `test`, `development`, `develop`, `dev`, then the repository default. For a different branch per repository, set `links[].base = {"adall.api": "test", "app.adall": "main"}` in `~/.signalbird/config.json`.

### Claude session (Claude Code only)

Janet runs the `claude` command in a terminal session, which is separate from the Claude desktop app. If the panel says the Claude session expired:

```bash
claude setup-token              # prints a long-lived token
signalbird fix claude-token     # paste it here
```

The token is stored in `~/.signalbird/config.json` (0600) and passed only to the `claude` process.

### Requirements

- Node.js 20+, git
- [GitHub CLI](https://cli.github.com) signed in (`gh auth login`)
- An AI agent installed and signed in: [Claude Code](https://docs.claude.com/claude-code), [Codex](https://github.com/openai/codex) or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

### Safety

- Janet never pushes to the target branch. It only pushes `janet/…` branches and opens pull requests. No force push.
- It refuses to run as `root`. It is meant for your development machine, not for servers.
- Local paths are never sent. The API only knows domain, channel and folder names.
- The agent runs without permission prompts (Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Gemini `--yolo`) inside the job folder, with your user's rights. Do not turn on automatic fixing for channels fed by sources you do not trust.
- Known secret patterns (`sb_*_live_`, `sk-`, `ghp_`, `AKIA…`) are masked before a log line reaches the panel.

---

## Sender: one event from any shell

```bash
signalbird send login --key sb_secret_live_…
signalbird send error "payment queue stopped" --channel adallCritical --source deploy
```

| Command | |
| --- | --- |
| `signalbird send <level> <message> --channel <channel> [--key …] [--source x] [--context '{"a":1}']` | Writes one event. Levels: `debug`, `info`, `warn`, `error`, `critical`. `-c` is short for `--channel`. |
| `signalbird send login --key sb_secret_live_… [--api URL]` | Saves the key so later calls do not need `--key`. |

Key lookup order: `--key`, then the `SIGNALBIRD_KEY` environment variable, then `config.json`. Notification rules (who gets called, quiet hours) live in the panel, not in your script.

---

## Server agent: the inside view of a Linux server

Reads load, CPU, memory, swap, disk and inodes, systemd services, listening ports, top processes, MySQL/MariaDB/PostgreSQL and Socket.io health. Sends new lines from allowed log files to Radio and forwards expected signals ("the backup finished"). **It accepts no commands**: the panel can only change settings (which metric, which interval, which log).

Linux with systemd is required for the service. On macOS `signalbird agent run` works in the foreground for testing.

```bash
sudo npm i -g signalbird-cli          # install globally, npx cannot install a service
sudo signalbird agent install --token=sba_live_…
sudo signalbird agent status
journalctl -u signalbird-agent -f
```

The token is shown in **Servers → Add server**. `install` checks the token with Signalbird first (a wrong token is never written), then writes `/etc/signalbird/agent.conf` (0600) and `/etc/systemd/system/signalbird-agent.service` and starts it. The unit runs as root with `ProtectSystem=strict`; it can only write to `/var/lib/signalbird` and `/var/log`.

| Command | |
| --- | --- |
| `sudo signalbird agent install --token=sba_live_… [--api URL] [--allow=/var/log,/srv/app/logs]` | Writes the config, installs and starts the systemd service. `--allow` sets the folders the panel may read logs from (default `/var/log`). |
| `signalbird agent run` | Runs continuously (the service uses this). |
| `sudo signalbird agent once` | One round: settings, logs, file signals, metrics. Good for testing. |
| `sudo signalbird agent signal <key> [ok\|fail] [message]` | Sends an expected signal. `fail` raises the alarm immediately. |
| `sudo signalbird agent status` | Local config, service state and a connection test. |
| `sudo signalbird agent uninstall` | Removes the service. Config and state files stay. |
| `signalbird agent version` | Agent protocol version (separate from the package version). |

Backup script example:

```bash
if mysqldump --all-databases | gzip > /var/backups/db.sql.gz; then
  signalbird agent signal db-backup ok "$(du -h /var/backups/db.sql.gz | cut -f1)"
else
  signalbird agent signal db-backup fail "mysqldump failed"
fi
```

Database credentials stay in `/etc/signalbird/agent.conf` and are never sent. Give the agent a read-only user:

```ini
db_driver=mysql        # mysql | mariadb | pgsql
db_host=127.0.0.1
db_port=3306
db_user=signalbird_ro
db_pass=…
db_name=shop
```

The full list of commands the agent runs is fixed in code and documented in [docs/AGENT-COMMANDS.md](docs/AGENT-COMMANDS.md). A log path chosen in the panel that is not under `--allow` is never read, symbolic links included.

---

## Files and environment

| | |
| --- | --- |
| `~/.signalbird/config.json` | Janet and sender settings (0600). Override with `SIGNALBIRD_CONFIG`, or move the whole folder with `SIGNALBIRD_HOME`. |
| `~/.signalbird/fix/jobs/` | Job clones. Deleted when a job is resolved, rejected or stopped. |
| `/etc/signalbird/agent.conf` | Server agent settings (0600). |
| `SIGNALBIRD_NO_BROWSER=1` | `signalbird login` prints the approval link instead of opening a browser (also automatic over SSH). |
| `NO_COLOR=1` | Plain output without colors. |

## Development

```bash
npm install
npm test
```

Contracts: [PROTOCOL.md](PROTOCOL.md) (Janet and sender), [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md) (server agent).

ahmet selim çil | ahmet@pariette.com
