# Bitrix24 Partner Request Automation

This project automates accepting Bitrix24 Partner App requests from:

`https://cultiv.bitrix24.com/marketplace/app/26/`

It targets only requests matching these Bitrix filters:

- `Request: Can take`
- `Personal request: Yes`

The automation uses Playwright so it behaves like a real logged-in user. It also records network traffic for the Partner App so DevOps can later evaluate whether the same action can be moved to a direct HTTP/API implementation.

## What Was Validated

The visible one-request validation succeeded with:

```powershell
node src/bitrix-partner-requests.mjs run --live --individual --limit 1 --headed
```

Result:

- found `3` matching requests
- accepted `1` request
- left `2` remaining
- no errors

## Files

- `src/bitrix-partner-requests.mjs` - main automation script
- `.env.example` - environment variable template
- `package.json` - dependencies and npm scripts
- `work/auth/bitrix-storage-state.json` - saved browser login session, created by the login command
- `work/runs/<timestamp>/summary.json` - optional structured report for each execution
- `work/runs/<timestamp>/network.jsonl` - optional captured relevant network calls
- `work/runs/<timestamp>/*.png` - optional before/after/error screenshots

`work/auth`, `work/runs`, `node_modules`, and `.env` are intentionally ignored by git.

## Prerequisites

Install on the host/server:

- Node.js 20 or newer
- npm, pnpm, or another Node package manager
- outbound HTTPS access to:
  - `cultiv.bitrix24.com`
  - `util.bitrixsoft.com`
  - your SMTP provider

## Installation

From the project folder:

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

If `npm` is unavailable, use another package manager, then run the script directly with `node`.

## Environment Configuration

Edit `.env`:

```env
BITRIX_URL=https://cultiv.bitrix24.com/marketplace/app/26/
BITRIX_EMAIL=your-bitrix-login-email
BITRIX_PASSWORD=your-bitrix-password

DRY_RUN=true
ACCEPT_MODE=bulk
RUN_EVERY_HOURS=5
HEADLESS=true
SAVE_OUTPUT_FILES=false

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=sender@example.com
SMTP_PASS=app-password-or-smtp-password
EMAIL_FROM=sender@example.com
BUSINESS_EMAIL_TO=business1@example.com,business2@example.com
DEV_EMAIL_TO=devops@example.com,developer@example.com
```

For Gmail, use a Google App Password, not the normal account password.

## First-Time Login

Run once on the server or workstation:

```powershell
node src/bitrix-partner-requests.mjs login --headed
```

What happens:

1. A browser opens.
2. Complete Bitrix login and MFA if required.
3. When the Partner App loads, the script saves the browser session.
4. Session file is saved at `work/auth/bitrix-storage-state.json`.

If automatic save does not trigger, wait until the page is fully loaded and press Enter in the terminal.

### How Manual Login Works on a Server

The scheduled automation normally runs headless, but the first login needs an interactive browser session so Bitrix can create trusted cookies/session storage.

Recommended options:

- **Windows server with Remote Desktop:** connect to the server using RDP, open PowerShell in the project folder, run `node src/bitrix-partner-requests.mjs login --headed`, complete Bitrix login/MFA in the browser, then press Enter after the Partner App page is fully loaded.
- **Linux server with desktop/VNC:** connect to the server desktop or VNC session, run `node src/bitrix-partner-requests.mjs login --headed`, complete Bitrix login/MFA, then press Enter after the Partner App page is fully loaded.
- **Headless server with no GUI:** create the login state on a workstation or temporary GUI server first, then copy `work/auth/bitrix-storage-state.json` to the production server under the same project path.

After the login state exists, production runs can use:

```powershell
node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
```

or the scheduled `daemon` command.

Important security notes:

- Treat `work/auth/bitrix-storage-state.json` like a password because it contains the saved browser session.
- Do not commit it to git.
- Restrict file permissions so only the automation service user can read it.
- If Bitrix logs out, MFA changes, or the session expires, rerun the `login --headed` command and replace the saved auth file on the server.
- The scheduled job should run as the same OS user that owns the saved auth file, unless DevOps explicitly copies the file to the service user's project folder.

## Safe Validation

Dry run, no requests accepted:

```powershell
node src/bitrix-partner-requests.mjs run --dry-run --headed
```

Visible single-request live test:

```powershell
node src/bitrix-partner-requests.mjs run --live --individual --limit 1 --headed
```

This accepts exactly one matching request and is the recommended final validation before enabling the scheduled job.

## Production Execution

Accept all currently matching requests:

```powershell
node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
```

Recommended production settings in `.env`:

```env
DRY_RUN=false
ACCEPT_MODE=bulk
HEADLESS=true
RUN_EVERY_HOURS=5
SAVE_OUTPUT_FILES=false
```

`bulk` means "accept all matching requests." It intentionally uses the proven one-by-one accept URL for each request, because Bitrix may render its visual bulk shortcut hidden or unavailable.

## Command Options

Run modes:

```powershell
node src/bitrix-partner-requests.mjs login
node src/bitrix-partner-requests.mjs run
node src/bitrix-partner-requests.mjs daemon
```

Useful flags:

- `--dry-run` - list matching requests without accepting
- `--live` - accept matching requests
- `--bulk` - accept all matching requests one by one
- `--individual` - accept visible requests one by one
- `--limit 1` or `--limit=1` - stop after accepting N requests
- `--headed` or `--headless=false` - show the browser
- `--headless` or `--headless=true` - hide the browser
- `--no-output-files` or `--save-output-files=false` - do not write run artifacts to disk
- `--save-output-files` or `--save-output-files=true` - write screenshots, trace, summary JSON, and network logs

Examples:

```powershell
node src/bitrix-partner-requests.mjs run --dry-run
node src/bitrix-partner-requests.mjs run --live --individual --limit 1 --headed
node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
```

## Output Files

Output files are controlled by `SAVE_OUTPUT_FILES`.

When enabled, each run writes:

- summary JSON: `work/runs/<timestamp>/summary.json`
- screenshots: `work/runs/<timestamp>/*.png`
- network log: `work/runs/<timestamp>/network.jsonl`
- Playwright trace: `work/runs/<timestamp>/trace.zip`

For production servers, use:

```env
SAVE_OUTPUT_FILES=false
```

or pass:

```powershell
node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
```

With output files disabled, the developer email still includes the execution log and status details, but no screenshots, traces, summary JSON, or network logs are saved.

## Scheduling Every 5 Hours

Preferred DevOps approach: schedule one short run every 5 hours instead of keeping a long-lived process.

### Linux Cron

```cron
0 */5 * * * cd /opt/bitrix-partner-request-automation && /usr/bin/node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files >> /var/log/bitrix-partner-requests.log 2>&1
```

### systemd Timer

Service example:

```ini
[Unit]
Description=Bitrix24 Partner Request Automation

[Service]
Type=oneshot
WorkingDirectory=/opt/bitrix-partner-request-automation
ExecStart=/usr/bin/node src/bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
Environment=NODE_ENV=production
```

Timer example:

```ini
[Unit]
Description=Run Bitrix24 Partner Request Automation every 5 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=5h
Persistent=true

[Install]
WantedBy=timers.target
```

### Windows Task Scheduler

Program:

```text
node
```

Arguments:

```text
src\bitrix-partner-requests.mjs run --live --bulk --headless --no-output-files
```

Start in:

```text
C:\path\to\bitrix-partner-request-automation
```

Trigger: repeat every `5 hours`.

## Email Reports

The automation supports two email audiences.

### Business Report

Recipients: `BUSINESS_EMAIL_TO`

Use commas, semicolons, or new lines to send to multiple recipients.

The business report is sent only when at least one request is accepted. If a 5-hour interval finds no requests, no business email is sent.

The business report includes only:

- number of requests accepted
- requests remaining after the run
- accepted request details in a Bitrix-like table:
  - Request ID
  - Description
  - Date Created (UTC+3)
  - Region
  - Partner Offers

It does not include execution logs, network paths, stack traces, or developer diagnostics.

### Developer Report

Recipients: `DEV_EMAIL_TO`

Use commas, semicolons, or new lines to send to multiple recipients.

The developer report is sent for every execution, including:

- successful live runs
- dry runs
- runs with no requests found
- failed runs

It includes:

- result: success or failed
- start and finish time
- run mode and limit
- requests found, accepted, and remaining
- accepted/discovered request details
- concise issue list
- execution log
- run directory
- network log path

If SMTP variables are missing, the automation still runs and writes local reports under `work/runs/<timestamp>/`.

## Troubleshooting

If the script says `Partner app iframe did not load`:

- run with `--headed`
- confirm the page opens and the Partner App grid is visible
- rerun `node src/bitrix-partner-requests.mjs login`
- check `work/runs/<timestamp>/error.png`
- check `work/runs/<timestamp>/network.jsonl`

If login expires:

```powershell
node src/bitrix-partner-requests.mjs login
```

If Playwright says the browser executable is missing:

```powershell
npx playwright install chromium
```

If the server has MFA or captcha:

- run the first login in headed mode on a server with a display
- save `work/auth/bitrix-storage-state.json`
- make sure the scheduled job runs as the same OS user, or securely copy the auth state to the service user

## Operational Notes

- Keep `.env` and `work/auth/bitrix-storage-state.json` private.
- Start production with `--dry-run` first after any server move.
- Use `--limit 1 --headed` for safe live checks.
- Use `--bulk --headless` for the normal scheduled job.
- Review `network.jsonl` after successful live runs if you want to migrate from browser automation to direct HTTP/API calls later.
