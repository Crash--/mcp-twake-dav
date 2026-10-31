# Changelog

All notable changes to mcp-twake-dav are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
