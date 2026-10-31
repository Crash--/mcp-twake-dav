# Security Policy

mcp-twake-dav gives an AI assistant access to personal and professional data in [Twake.ai](https://twake.ai). We take its security seriously and thank everyone who reports issues responsibly.

## Supported versions

Security fixes are released for the latest minor version.

| Version | Supported |
|---|---|
| 3.1.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately, by one of these channels:

1. GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/linagora/mcp-twake-dav/security/advisories/new);
2. email to **dpo@linagora.com**.

Please include:

- the affected version or commit;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix or mitigation.

We will acknowledge your report within **5 business days**, keep you informed of the progress, and agree with you on a disclosure date once a fix is available. With your permission, we will credit you in the release notes.

## Security model and hardening

An MCP server acts **with the full rights of the account it is configured with**. Keep these points in mind:

- **Credentials**: `DAV_PASSWORD` and `DAV_TOKEN` are secrets. Prefer `DAV_CREDENTIALS_FILE` (kept out of the MCP client configuration) or `DAV_AUTH_METHOD=command` (short-lived tokens from a broker you control).
- **Invitations sent by the server**: creating, updating or deleting an event with attendees makes the CalDAV server email invitations or cancellations in the user's name. MCP clients should confirm these actions; `respond_to_invitation` can be filtered out.
- **Recurring events**: set `DAV_RECURRING_WRITES=false` to make `update_event` / `delete_event` refuse recurring series and occurrences.
- **Contacts are final**: CardDAV has no trash; `delete_contact` is irreversible.
- **Prompt injection**: event descriptions and contact notes may be written by third parties; treat them as untrusted content.
- **Transport**: HTTPS is enforced, except `localhost` / `127.0.0.1` for development.

General recommendations:

- Give the assistant only the tools it needs (most MCP clients support an allow-list or a deny-list of tools).
- Keep human confirmation for every action that writes, sends, shares or deletes.
- Run the server locally (stdio transport) next to your MCP client; never expose it on a network.
- To keep the whole chain sovereign, pair it with a self-hosted or European AI model.
