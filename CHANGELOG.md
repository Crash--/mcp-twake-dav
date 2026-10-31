# Changelog

All notable changes to mcp-twake-dav are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Node.js >= 20.3 is required (`AbortSignal.any`).
- `get_events_in_range`, `get_todays_schedule` and `search_events` take `limit` (default 50, maximum 100) and `cursor`, and return `nextCursor` while events remain, instead of cutting at 50 without saying so.
- A date range covers 92 days at most, including in `check_availability`. `get_events_in_range` covers the next 7 days without dates.
- `get_events_in_range` and `search_events` take `start` and `end` in ISO 8601 instead of `when`, and `check_availability` no longer takes natural language: the expressions it read as one day (`this week`, `next month`) are gone.
- A time-range read is one `calendar-query`, without a multiget. A window the server still refuses with 413 is split, down to one day.
- An event shows its first 10 attendees and how many more it has.

### Fixed
- A failing DAV read (401, 413, 429, 500, multiget included, or an error inside a 207) or an unknown calendar or address book name is an error for the assistant, with its status and what to do. Objects that could not be read are named next to the result, and so is a calendar this account has no access to: the other calendars still answer, and `check_availability` then says availability is unknown.
- Every DAV request has a 30 second timeout and is cancelled with its tool call. A read is retried only on 429, 503 and network errors, and `Retry-After` is honoured up to 10 seconds.
- PUT and DELETE are never retried. A write without an answer says that its outcome is unknown and must be checked first.
- Dates and "today" follow `USER_TIMEZONE`, not the time zone of the process.
- `check_availability` reads all calendars, not only the first one.
- An event appears in every range it overlaps, including an occurrence moved from another date.
- `search_events` filters before it cuts, so a match late in the range is found.
- `get_next_event` widens its search step by step instead of downloading a year.

## [3.1.0] - 2026-10-31

### Added
- `DAV_AUTH_METHOD=command`: the Bearer token comes from an external broker (`DAV_TOKEN_COMMAND`) and is refreshed before every call.
- `DAV_HREF_PREFIX` for servers published behind a prefix-stripping reverse proxy (Twake Calendar / OpenPaaS under `/dav`).
- `create_event` accepts attendees; the organizer comes from `DAV_ORGANIZER_EMAIL` / `DAV_ORGANIZER_NAME`.
- `DAV_RECURRING_WRITES=false` makes `update_event` / `delete_event` refuse recurring series and occurrences.

### Fixed
- `update_event` / `delete_event` find events by UID with a server-side query (some servers do not return every object on a full-collection query).

### Changed
- Node.js >= 20 is required (Node 18 is end-of-life).
- Repository moved to the [LINAGORA organisation](https://github.com/linagora/mcp-twake-dav); README rewritten (Twake.ai positioning, Twake Calendar setup, installation for Claude Desktop, Claude Code and Hermes Agent, recommended safe configuration).
- Community files: Code of Conduct, Security Policy, Contributing guide with DCO, issue and pull request templates, CI (Node 20 and 22) and Dependabot.

## Earlier versions

See the [git history](https://github.com/linagora/mcp-twake-dav/commits/master) and the [npm versions](https://www.npmjs.com/package/mcp-twake-dav?activeTab=versions).
