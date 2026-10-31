# Changelog

All notable changes to mcp-twake-dav are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Node.js >= 20.3 is required (`AbortSignal.any`).
- `list_invitations` takes `start` and `end` (ISO 8601 with an offset, 7 days by default, 92 at most), `limit` and `offset` instead of `timeRange`.
- `list_contacts`, `search_contacts` and `get_contact_details` take `limit` (default 30, maximum 100) and `cursor`, and return `nextCursor` while contacts remain.
- `get_events_in_range`, `get_todays_schedule` and `search_events` take `limit` (default 50, maximum 100) and `cursor`, and return `nextCursor` while events remain, instead of cutting at 50 without saying so.
- A date range covers 92 days at most, including in `check_availability`. `get_events_in_range` covers the next 7 days without dates.
- `get_events_in_range` and `search_events` take `start` and `end` in ISO 8601 instead of `when`, and `check_availability` no longer takes natural language: the expressions it read as one day (`this week`, `next month`) are gone.
- A time-range read is one `calendar-query`, without a multiget. A window the server still refuses with 413 is split, down to one day.
- An event shows its first 10 attendees and how many more it has.

### Fixed
- `list_invitations` and `respond_to_invitation` work: they read the event in the calendar of the attendee, with the address the server gives for this user, instead of never asking the server. Every VEVENT counts, so an occurrence or an exception is listed and answered, and a delegated calendar is left out.
- A failing DAV read (401, 413, 429, 500, multiget included, or an error inside a 207) or an unknown calendar or address book name is an error for the assistant, with its status and what to do. Objects that could not be read are named next to the result, and so is a calendar this account has no access to: the other calendars still answer, and `check_availability` then says availability is unknown.
- Every DAV request has a 30 second timeout and is cancelled with its tool call. A read is retried only on 429, 503 and network errors, and `Retry-After` is honoured up to 10 seconds.
- PUT and DELETE are never retried. A write without an answer says that its outcome is unknown and must be checked first.
- All tools follow `USER_TIMEZONE`, not the time zone of the process, for their dates, "today", all-day events and times without a zone. The time checked by `check_availability` is the time booked by `create_event`.
- The list of calendars is refreshed after a minute, so a calendar created after startup is read.
- A cancelled or moved occurrence is recognised with a `RECURRENCE-ID;TZID`, and an event of several days shows its end date.
- `check_availability` reads all calendars, not only the first one.
- An event appears in every range it overlaps, including an occurrence moved from another date.
- `search_events` filters before it cuts, so a match late in the range is found.
- `get_next_event` widens its search step by step instead of downloading a year.
- An unknown UID no longer reads every calendar. On Twake Calendar the lookup is one request on the JSON API; on other servers it is a UID query limited to 2 years around today, and the error says so. A UID in several calendars asks for a calendar name.
- Contact searches and UID lookups are filtered by the server instead of reading the address book, and their output is bounded. On Twake, `list_contacts` pages on the server. Each page checks the CTag, so a contact added elsewhere is seen and a book changed between two pages is signalled.

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
