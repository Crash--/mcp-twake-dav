# Changelog

All notable changes to mcp-twake-dav are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [4.1.0] - 2026-11-02

Load on the calendar server, measured on a real account (one call each, fresh process):

| Call | 4.0.0 | 4.1.0 |
|---|---|---|
| `update_event` / `delete_event` on a UID absent from the default calendar | 25 MB, 11 s | 36 KB, 2 s |
| `search_contacts`, `get_contact_details` | 6 to 9 MB each | 7 KB |
| `list_invitations` | no request at all, always "no pending invitations" | works, one 30-day read |
| `get_events_in_range` over 5 years | 25 MB | refused without a request (92 days at most) |

DAV errors, timeouts and retries (#13) and pagination with 92-day ranges (#19) are by Crash--.

### Fixed
- An unknown UID read every event of the calendar(s) after the server had already answered "no such UID" to the filtered query (tens of megabytes on a large calendar, for the same answer). The full read is now kept for servers that refuse the UID filter only.
- `search_contacts` and `get_contact_details` downloaded every contact of the address book(s) on each call: the server now matches the name (FN, N) or the organization (ORG), case-insensitive; the exact filters still apply. Servers without this filter get the full read as before.
- `list_invitations` never reached the server: it needed the principal URL from `client.account`, which `createDAVClient` does not expose, and silently answered that there was nothing pending. It now asks the calendars (the default calendar, `calendar`, or `"all"`) for events where you are an attendee with `PARTSTAT=NEEDS-ACTION`, from now to 30 days ahead by default, 50 listed at most with the total. The scheduling inbox is no longer used: it keeps every iTIP message ever received (850 on the test account, 10 s of server work per query) while the calendar holds the current state.
- `respond_to_invitation` changed the copy of the invitation in the scheduling inbox and found it through that list: it now finds the event by UID in your calendars (`calendar` optional), checks that you are one of its attendees, and changes your answer on that event; the server sends the reply (RFC 6638 implicit scheduling). Your address is `DAV_ORGANIZER_EMAIL` (or `DAV_USERNAME` when it is an e-mail address); with an SSO token it is required.
- An unreadable `timeRange` of `list_invitations` is an error instead of being ignored.
- A failing DAV read (401, 413, 429, 500, or an error inside a 207) or an unknown calendar or address book name is an error for the assistant, with its status and what to do. Objects that could not be read are named next to the result, and so is a calendar this account has no access to: the other calendars still answer, and `check_availability` then says availability is unknown.
- Every DAV request has a 30 second timeout and is cancelled with its tool call. A read is retried only on 429, 503 and network errors, and `Retry-After` is honoured up to 10 seconds.
- PUT and DELETE are never retried. A write without an answer says that its outcome is unknown and must be checked first.
- An event that cannot be read or expanded is named next to the result, and `check_availability` then says availability is unknown, instead of "No events found" or "You are free".
- A series is read up to 10 000 occurrences in a range instead of 100, and a warning says when it is cut.

### Changed
- Node.js >= 20.3 is required (`AbortSignal.any`).
- Events and contacts are read with one query that returns the data, without a multiget.
- `tsdav` is pinned to exactly 2.5.0: the fetch guard and the reads depend on how it works inside, and a published package has no lockfile.
- An event shows its first 10 attendees and how many more it has.
- `get_events_in_range`, `get_todays_schedule` and `search_events` take `limit` (default 50, maximum 100) and `cursor`, and return `nextCursor` while events remain.
- A date range covers 92 days at most, including in `check_availability`.

## [4.0.0] - 2026-11-01

### Added
- Prior approval of every write by the user, asked by the server itself through MCP elicitation (`DAV_APPROVAL=elicit`, the default): `create_event`, `update_event`, `delete_event`, `add_alarm`, `remove_alarm`, `respond_to_invitation`, `create_contact`, `update_contact` and `delete_contact` show the exact action (dates as parsed, current event or contact, attendees who will receive an e-mail, a unique reference) and write only on accept. Prompts in English or French (`USER_LANGUAGE`), `DAV_APPROVAL_TIMEOUT_MS`.
- `scripts/live-approval.mjs`: live test of the approvals on a real calendar and address book.

### Changed
- **Breaking**: with an MCP client that does not support elicitation, write tools now return an error and write nothing. Set `DAV_APPROVAL=client` to keep the 3.x behaviour when your client confirms writes itself.

### Fixed
- "next 7 days", "the next 2 weeks", "les 10 prochains jours" covered a single day (chrono-node reads "next 7 days" as the day in 7 days): they now cover today and the following days.

## [3.3.0] - 2026-11-01

### Fixed
- `check_availability` marked whole days busy as soon as the range met an all-day event (holiday, trade show, custody days), and a multi-day all-day event swallowed the meetings of the following days: the server free-busy report cannot tell such markers from meetings. Busy periods are now computed from the events, all-day events are listed apart, and periods ending on another day show their date.
- Events that started before the queried range but overlap it (a multi-day all-day event, a meeting already running, a recurring occurrence) were dropped by every read tool.
- `search_events` truncated the events to 50 before filtering by keyword, so matches beyond the first 50 events of the range were never found; `get_events_in_range` truncated silently. Both now work on the whole range and say when only the first 50 are shown.
- `check_availability` with `calendar: "all"` only queried the first calendar.

### Added
- `check_availability` `all_day_busy` option (count all-day events as busy).
- All-day events are shown as dates (`Thu, Nov 5 – Sun, Nov 8 (all day)`) instead of `12:00 AM - 12:00 AM`.

## [3.2.0] - 2026-11-01

### Fixed
- `get_events_in_range` with a period ("next week", "this week", "next month", "next weekend", and the French forms "la semaine prochaine", "ce mois-ci"…) returned a single day (chrono-node reads "next week" as today + 7 days), often an empty one. Periods now cover the whole week (Monday to Sunday), month or weekend.
- With tsdav 2.5 (native fetch, no cross-fetch), `DAV_HREF_PREFIX` rewriting goes through tsdav's `fetch` option: the previous cross-fetch patch made the server fail at startup.

### Changed
- Dependencies: tsdav 2.5, @modelcontextprotocol/sdk 1.32, zod 4.6, chrono-node 2.10, TypeScript 7, vitest 5; CI actions v7.

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
