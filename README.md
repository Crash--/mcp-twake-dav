# mcp-twake-dav

[![npm version](https://img.shields.io/npm/v/mcp-twake-dav)](https://www.npmjs.com/package/mcp-twake-dav)
[![CI](https://github.com/linagora/mcp-twake-dav/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/mcp-twake-dav/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Give your AI assistant secure access to Twake Calendar and your contacts, in the [Twake.ai](https://twake.ai) Digital Workplace.**

![Twake Calendar](assets/twake-calendar-screenshot.png)

## What is it?

`mcp-twake-dav` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. MCP is the open standard that lets AI assistants (Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code and many others) use external tools. This server exposes your **calendars** and **address books** to the assistant as **20 tools**: agenda, availability, events, reminders, invitations and contacts.

It speaks the open standards **CalDAV** ([RFC 4791](https://www.rfc-editor.org/rfc/rfc4791)), **CardDAV** ([RFC 6352](https://www.rfc-editor.org/rfc/rfc6352)) and CalDAV scheduling ([RFC 6638](https://www.rfc-editor.org/rfc/rfc6638)). It is built for Twake Calendar and works with other SabreDAV-compatible servers (Nextcloud, SOGo, DAViCal, ownCloud…).

## Part of Twake.ai

[Twake.ai](https://twake.ai) is the truly open source and sovereign Digital Workplace developed by [LINAGORA](https://linagora.com): Twake Mail, Twake Calendar, Twake Drive, Twake Chat, Twake Space and Twake Visio with a single account, hosted in France or on your own infrastructure.

Five open source MCP servers connect AI assistants to the whole workplace:

| MCP server | Twake.ai service | Protocol |
|---|---|---|
| [mcp-twake-mail](https://github.com/linagora/mcp-twake-mail) | Twake Mail | JMAP |
| **mcp-twake-dav** (this project) | Twake Calendar and contacts | CalDAV / CardDAV |
| [mcp-twake-drive](https://github.com/linagora/mcp-twake-drive) | Twake Drive | cozy-stack API |
| [mcp-twake-chat](https://github.com/linagora/mcp-twake-chat) | Twake Chat | Matrix |
| [mcp-twake-space](https://github.com/linagora/mcp-twake-space) | Twake Space (team spaces) | Twake Space API |

Used together, they let one assistant prepare a meeting from the invitation, the related email thread, the chat discussion and the documents in the drive, without your data leaving your servers.

## What it brings

- **Your day at a glance**: "What's on my agenda today? Where is my 3 pm meeting?"
- **Finding a slot**: "When am I free for one hour with Marie next week?" Busy periods come from the events themselves; all-day events (holidays, trade shows, days off) are listed apart instead of blocking whole days.
- **Scheduling in natural language**: "Book a project review on Tuesday at 10 with Pierre and Marie" (dates like "next Monday" or "in two weeks" are understood).
- **Reminders and invitations**: add or remove reminders, list pending invitations and answer them.
- **Contacts**: find an email address or a phone number, create and update contact cards.
- **Sovereignty**: the server runs next to your assistant and talks directly to your calendar server. Pair it with a self-hosted or European AI model to keep the whole chain under your control.

## Features

### 20 MCP tools

| Category | Tools |
|---|---|
| Calendar, read | `get_next_event`, `get_todays_schedule`, `get_events_in_range`, `search_events`, `check_availability`, `list_calendars` |
| Calendar, write | `create_event` (with attendees and recurrence), `update_event`, `delete_event` ⚠️, `add_alarm`, `remove_alarm` |
| Invitations | `list_invitations`, `respond_to_invitation` ⚠️ |
| Contacts, read | `search_contacts`, `get_contact_details`, `list_contacts`, `list_addressbooks` |
| Contacts, write | `create_contact`, `update_contact`, `delete_contact` ⚠️ |

⚠️ = deletes data or makes the server notify other people. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).

**Every write is approved by you first.** Before `create_event`, `update_event`, `delete_event`, `add_alarm`, `remove_alarm`, `respond_to_invitation`, `create_contact`, `update_contact` or `delete_contact` writes anything, the server itself shows you the exact action through MCP elicitation (see [Prior approval](#prior-approval)) and acts only on your explicit OK.

### Highlights

- **Attendees and organizer**: `create_event` invites attendees, with the organizer taken from `DAV_ORGANIZER_EMAIL` / `DAV_ORGANIZER_NAME`; the server sends the invitations.
- **Recurring events**: RRULE expansion with safety limits, single-occurrence edits and deletions, and an opt-out (`DAV_RECURRING_WRITES=false`) for cautious deployments.
- **Reliable updates**: events are found by UID with a server-side query; updates use parse-modify-serialize, so alarms, attendees and `X-` properties are preserved.
- **Status display**: cancelled and tentative events, attendee participation status.
- **Five authentication methods**: Basic, Bearer, OpenPaaS ESNToken, **token command** (short-lived tokens refreshed before every call) and an external credentials file.
- **Reverse proxy support**: `DAV_HREF_PREFIX` for servers published under a path prefix that their responses omit (Twake Calendar / OpenPaaS).
- CTag-based caching, retries with backoff, natural-language dates ([chrono-node](https://github.com/wanasit/chrono)), HTTPS enforced.

## Requirements

- **Node.js** >= 20
- A **CalDAV / CardDAV server**: Twake Calendar, Nextcloud, SOGo, DAViCal, ownCloud… (HTTPS required, except `localhost`)
- An **MCP client**: Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code, or any MCP-compatible assistant

## Installation

**Interactive setup (recommended):**

```bash
npx mcp-twake-dav setup
```

The wizard asks for your server URL and credentials, tests the connection, lists your calendars and address books, lets you pick the defaults, and can write the Claude Desktop configuration for you.

**Global install:**

```bash
npm install -g mcp-twake-dav
```

**From source:**

```bash
git clone https://github.com/linagora/mcp-twake-dav.git
cd mcp-twake-dav
npm install
npm run build          # then run: node build/index.js
```

## Configuration

The server is configured through environment variables, usually set in your MCP client configuration.

### Authentication

| Method | Variables |
|---|---|
| **Basic** (default) | `DAV_URL`, `DAV_USERNAME`, `DAV_PASSWORD` |
| **Bearer** | `DAV_URL`, `DAV_AUTH_METHOD=bearer`, `DAV_TOKEN` |
| **ESNToken** (OpenPaaS) | `DAV_URL`, `DAV_AUTH_METHOD=esntoken`, `DAV_TOKEN` |
| **Token command** | `DAV_URL`, `DAV_AUTH_METHOD=command`, `DAV_TOKEN_COMMAND` |

- With **token command**, the server runs `DAV_TOKEN_COMMAND` to get an access token, either raw on stdout or as JSON `{"access_token": "...", "expires_at": <epoch seconds>}`, and refreshes it before every call. A single broker you control can then own the OIDC grant for several tools.
- `DAV_CREDENTIALS_FILE` points to a file holding `DAV_USERNAME=…`, `DAV_PASSWORD=…` or `DAV_TOKEN=…` lines, so secrets stay out of the MCP client configuration.

### Other options

| Variable | Description | Default |
|---|---|---|
| `DAV_DEFAULT_CALENDAR` | Calendar used when the assistant does not name one (`"all"` in a tool call still searches every calendar) | all calendars |
| `DAV_DEFAULT_ADDRESSBOOK` | Address book used by default | all address books |
| `DAV_ORGANIZER_EMAIL` / `DAV_ORGANIZER_NAME` | Organizer written in events that have attendees | none |
| `DAV_RECURRING_WRITES` | `false` = `update_event` / `delete_event` refuse recurring series and occurrences | `true` |
| `DAV_HREF_PREFIX` | Path prefix stripped by a reverse proxy, e.g. `/dav` for Twake Calendar / OpenPaaS | none |
| `USER_TIMEZONE` | IANA time zone used to display and interpret dates, e.g. `Europe/Paris` | system time zone |
| `DAV_APPROVAL` | `elicit`: the server asks you before every write; `client`: your MCP client confirms | `elicit` |
| `DAV_APPROVAL_TIMEOUT_MS` | How long an approval prompt waits for your answer | `600000` |
| `USER_LANGUAGE` | Language of the approval prompts, `en` or `fr` | `en` |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` | `info` |

### Prior approval

With `DAV_APPROVAL=elicit` (the default), every write tool sends the MCP client an [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) request before it writes, for instance:

```
Twake Calendar: Delete an event (cannot be undone)
As: Jane DOE (your account)
Event: Budget review · 2026-11-05 14:00 → 15:00 (Europe/Paris)
Notified: Bob DURAND (the server may send them a cancellation)

Ref. 3f9a1c · Accept to do it now, refuse to cancel.
```

- The prompt shows the dates as the server understood them, the event being changed, the attendees who will receive an e-mail, and the contact's current values.
- The server writes only on *accept*. A refusal, a dismissal, a timeout (`DAV_APPROVAL_TIMEOUT_MS`, 10 minutes) or an error writes nothing, and the tool tells the assistant not to retry.
- A client without elicitation support gets an error and nothing is written. Set `DAV_APPROVAL=client` only if your MCP client asks you to confirm every write tool itself.
- `USER_LANGUAGE=fr` writes the prompts in French.

### Twake Calendar

Twake Calendar publishes its SabreDAV endpoint under `/dav/` and accepts OIDC Bearer tokens:

```bash
DAV_URL=https://calendar.example.com/dav/
DAV_HREF_PREFIX=/dav
DAV_AUTH_METHOD=command
DAV_TOKEN_COMMAND="/usr/local/bin/my-token-broker token"
DAV_ORGANIZER_EMAIL=jane.doe@example.com
DAV_DEFAULT_CALENDAR="Jane Doe"
```

Without `DAV_HREF_PREFIX`, discovery fails with `cannot find homeUrl` or calendars come back empty.

## Use it with your assistant

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "twake-dav": {
      "command": "npx",
      "args": ["-y", "mcp-twake-dav"],
      "env": {
        "DAV_URL": "https://dav.example.com",
        "DAV_USERNAME": "jane.doe@example.com",
        "DAV_PASSWORD": "your-password",
        "DAV_DEFAULT_CALENDAR": "My Calendar",
        "DAV_DEFAULT_ADDRESSBOOK": "My Contacts",
        "USER_TIMEZONE": "Europe/Paris"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add twake-dav --scope user \
  -e DAV_URL=https://dav.example.com \
  -e DAV_USERNAME=jane.doe@example.com \
  -e DAV_CREDENTIALS_FILE=~/.config/mcp-twake-dav/credentials \
  -- npx -y mcp-twake-dav
```

### Hermes Agent

```yaml
mcp_servers:
  twake_dav:
    command: npx
    args: ["-y", "mcp-twake-dav"]
    env:
      DAV_URL: https://calendar.example.com/dav/
      DAV_HREF_PREFIX: /dav
      DAV_AUTH_METHOD: command
      DAV_TOKEN_COMMAND: /usr/local/bin/my-token-broker token
      DAV_ORGANIZER_EMAIL: jane.doe@example.com
      DAV_RECURRING_WRITES: "false"
      DAV_APPROVAL_TIMEOUT_MS: "330000"
      USER_LANGUAGE: fr
    timeout: 420            # longer than the approval wait
    elicitation:
      enabled: true
      timeout: 300
```

Hermes shows the approval prompts in the desktop app, the terminal or on your messaging platform, and declines them where nobody can answer (cron jobs, one-shot queries).

### Other MCP clients

Any client that can launch a stdio MCP server works: command `npx`, arguments `-y mcp-twake-dav`, and the environment variables above.

## Recommended safe configuration

Creating, moving or deleting an event with attendees makes the server **email them in your name**, and contact deletion is final (CardDAV has no trash). For an assistant that acts on its own:

- keep `DAV_APPROVAL=elicit` (the default): every write waits for your OK on the exact action, whatever the assistant decides;
- set `DAV_RECURRING_WRITES=false` and edit recurring series in Twake Calendar;
- filter out `respond_to_invitation` (and `delete_contact` if not needed) in your MCP client, for example with Hermes Agent:

```yaml
    tools:
      exclude: [respond_to_invitation, delete_contact]
```

Event descriptions and contact notes may be written by third parties (prompt injection). See [SECURITY.md](SECURITY.md).

## Usage examples

- "What's my next meeting, and where is it?"
- "Show my schedule for this week."
- "Am I free tomorrow afternoon? Find me a 45-minute slot."
- "Create a meeting with Pierre on Thursday at 2 pm and invite him."
- "Add a 15-minute reminder to my dentist appointment."
- "Do I have pending invitations?"
- "What's Marie's email address? Update her phone number."

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Configuration validation failed` | Set the variables required by your `DAV_AUTH_METHOD` (see *Authentication*). |
| `Not done: this MCP client cannot ask the user for approval` | Your MCP client does not support elicitation: use one that does, or `DAV_APPROVAL=client` if it confirms writes itself. |
| `Not done: no answer to the approval request` | The prompt timed out or nobody could answer (cron, one-shot query): nothing was written. |
| `401 Unauthorized` | Check the credentials; with a token, check that it is valid and not expired. |
| `URL must use HTTPS` | Use `https://` (HTTP is only accepted for `localhost` / `127.0.0.1`). |
| `cannot find homeUrl` / empty calendars | The server sits behind a path prefix: set `DAV_HREF_PREFIX` (e.g. `/dav`). |
| `Event not found` on update or delete | Pass the calendar name, or `calendar: "all"`. |
| No calendars or address books | Check the account's permissions in the server's web interface. |
| Tools missing in the client | Restart the client after editing its configuration; check that `npx` is in the `PATH`. |

Run with `LOG_LEVEL=debug` for details (logs go to stderr).

## Architecture

```
MCP client ⇄ stdio (JSON-RPC) ⇄ mcp-twake-dav ⇄ HTTPS (CalDAV / CardDAV) ⇄ Twake Calendar / any DAV server
```

Layers: Zod configuration with HTTPS enforcement, Pino logger on stderr, [tsdav](https://github.com/natelindev/tsdav) clients with pluggable authentication and href-prefix rewriting, retry and CTag cache, calendar and address book services, [ical.js](https://github.com/kewisch/ical.js) transformers (iCalendar, vCard, RRULE, time zones), and the MCP tools.

## Development

```bash
npm install
npm run build    # compile TypeScript
npm test         # Vitest suite, no real server needed
npm run dev      # watch mode
node scripts/check-command-auth.mjs   # token-command refresh against a mock CalDAV server
```

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)

## About

`mcp-twake-dav` is developed by [LINAGORA](https://linagora.com), French open source software publisher, as part of [Twake.ai](https://twake.ai). For support, hosting or integration of Twake.ai and its AI connectors, contact LINAGORA at <https://linagora.com>.
