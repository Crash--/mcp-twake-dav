# Changelog

All notable changes to mcp-twake-dav are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
