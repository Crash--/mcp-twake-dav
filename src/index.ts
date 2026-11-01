#!/usr/bin/env node
/**
 * MCP server entry point for mcp-twake-dav
 *
 * Startup sequence:
 * 1. Load and validate configuration (fail-fast on invalid env vars)
 * 2. Initialize logger with stderr destination
 * 3. Test CalDAV/CardDAV connection (with 10s timeout)
 * 4. Initialize MCP server
 * 5. Connect stdio transport
 *
 * CRITICAL: All logs go to stderr. stdout is reserved for MCP JSON-RPC protocol.
 */

import { VERSION } from './version.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/schema.js';
import { createLogger } from './config/logger.js';
import { createDualClients, validateDualConnection } from './caldav/client.js';
import { CalendarService } from './caldav/calendar-service.js';
import { AddressBookService } from './caldav/addressbook-service.js';
import { formatStartupError } from './errors.js';
import { createServer } from './server.js';

/**
 * Main entry point with full startup validation
 */
async function main() {
  let davUrl: string | undefined;

  try {
    // Step 1: Load and validate configuration
    const config = loadConfig();
    davUrl = config.DAV_URL;

    // Step 2: Initialize logger (uses config.LOG_LEVEL)
    const logger = createLogger(config.LOG_LEVEL);
    logger.info({ version: VERSION }, 'Starting mcp-twake-dav server');

    // Step 3: Create dual CalDAV/CardDAV clients
    const clients = await createDualClients(config, logger);

    // Step 4: Validate connection (discovers calendars + address books)
    const { calendarCount, addressBookCount } = await validateDualConnection(clients, config, logger);
    logger.info({ calendarCount, addressBookCount }, 'CalDAV/CardDAV clients ready');

    // Step 5: Initialize services
    const calendarService = new CalendarService(clients.caldav, logger, config);
    const addressBookService = new AddressBookService(clients.carddav, logger);
    logger.info('Calendar and AddressBook services initialized');

    // Step 6: Initialize MCP server with tools registered
    const server = createServer(calendarService, addressBookService, logger, config.DAV_DEFAULT_CALENDAR, config.DAV_DEFAULT_ADDRESSBOOK, config.USER_TIMEZONE, {
      DAV_USERNAME: config.DAV_USERNAME,
      DAV_ORGANIZER_EMAIL: config.DAV_ORGANIZER_EMAIL,
      DAV_ORGANIZER_NAME: config.DAV_ORGANIZER_NAME,
      DAV_RECURRING_WRITES: config.DAV_RECURRING_WRITES,
      DAV_APPROVAL: config.DAV_APPROVAL,
      DAV_APPROVAL_TIMEOUT_MS: config.DAV_APPROVAL_TIMEOUT_MS,
      USER_LANGUAGE: config.USER_LANGUAGE,
    });
    logger.info('MCP server initialized');

    // Step 7: Connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP server connected via stdio transport');
  } catch (error) {
    // Format error with AI-friendly message and exit
    const errorMessage = formatStartupError(
      error instanceof Error ? error : new Error(String(error)),
      davUrl
    );
    console.error(`\n${errorMessage}\n`);
    process.exit(1);
  }
}

// CLI routing: `mcp-twake-dav setup` launches the wizard, otherwise starts the MCP server
const args = process.argv.slice(2);
if (args[0] === 'setup') {
  const { runSetup } = await import('./cli/setup.js');
  runSetup().catch((err) => {
    console.error('\nSetup failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  main();
}
