/**
 * AI-friendly error message formatting for startup failures
 *
 * Purpose: Provide actionable error messages that help Claude diagnose
 * configuration issues and guide users to fix them.
 *
 * Pattern: "What went wrong" + "How to fix it"
 */

import { ZodError } from 'zod';

/**
 * Format a startup error into an AI-friendly, actionable message
 *
 * @param error - The error that occurred during startup
 * @param url - Optional DAV_URL for context in certain error types
 * @returns User-friendly error message with fix suggestions
 */
export function formatStartupError(error: Error, url?: string): string {
  // Handle Zod validation errors (missing/invalid env vars)
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => {
      const field = issue.path.join('.');
      return `  ${field}: ${issue.message}`;
    });
    return [
      'Configuration validation failed:',
      ...issues,
      '',
      'Fix: Check your environment variables.',
      'For basic auth (default): DAV_URL, DAV_USERNAME, DAV_PASSWORD',
      'For bearer auth: DAV_URL, DAV_AUTH_METHOD=bearer, DAV_TOKEN',
      'For esntoken auth: DAV_URL, DAV_AUTH_METHOD=esntoken, DAV_TOKEN',
    ].join('\n');
  }

  const message = error.message.toLowerCase();
  const errorMessage = error.message;

  // Authentication failures (401, 'auth', 'unauthorized')
  if (
    message.includes('401') ||
    message.includes('auth') ||
    message.includes('unauthorized')
  ) {
    return [
      'Authentication failed for the configured CalDAV server.',
      '',
      'Fix: Verify your credentials are correct.',
      'If using basic auth: check DAV_USERNAME and DAV_PASSWORD.',
      'If using bearer/esntoken: check DAV_TOKEN is valid and not expired.',
      'You can switch auth methods with DAV_AUTH_METHOD (basic, bearer, esntoken).',
    ].join('\n');
  }

  // DNS/unreachable (ENOTFOUND)
  if (message.includes('enotfound') || message.includes('not found')) {
    const urlContext = url ? ` at ${url}` : '';
    return [
      `Cannot find server${urlContext}.`,
      '',
      'Fix: Check the DAV_URL is spelled correctly and the server exists.',
      'Example: DAV_URL=https://dav.example.com',
    ].join('\n');
  }

  // Timeout (ETIMEDOUT, 'timeout')
  if (message.includes('etimedout') || message.includes('timeout')) {
    const urlContext = url ? ` ${url}` : '';
    return [
      `Connection to${urlContext} timed out.`,
      '',
      'Fix: Check the server is running and accessible from your network.',
      'Try accessing the URL in a browser to verify it responds.',
    ].join('\n');
  }

  // Connection refused (ECONNREFUSED)
  if (message.includes('econnrefused') || message.includes('connection refused')) {
    const urlContext = url ? ` ${url}` : '';
    return [
      `Connection refused by${urlContext}.`,
      '',
      'Fix: Check the server is running and the port is correct.',
      'Verify the URL includes the correct port (e.g., https://dav.example.com:8443).',
    ].join('\n');
  }

  // SSL/TLS errors (certificate, CERT, SSL)
  if (
    message.includes('certificate') ||
    message.includes('cert') ||
    message.includes('ssl') ||
    message.includes('tls')
  ) {
    const urlContext = url ? ` for ${url}` : '';
    return [
      `SSL certificate error${urlContext}.`,
      '',
      'Fix: The server may have an invalid or self-signed certificate.',
      'For production: Ensure the server has a valid SSL certificate.',
      'For development: You may need to configure certificate acceptance.',
    ].join('\n');
  }

  // Fallback for unexpected errors
  return [
    `Unexpected error: ${errorMessage}`,
    '',
    'Fix: Check your configuration and try again.',
    'Verify DAV_URL and your auth settings (DAV_USERNAME/DAV_PASSWORD or DAV_AUTH_METHOD/DAV_TOKEN).',
  ].join('\n');
}

/**
 * ConflictError - thrown when a CalDAV/CardDAV server returns HTTP 412 Precondition Failed
 *
 * This happens when an ETag mismatch is detected during optimistic concurrency control,
 * indicating that the resource was modified by another client since it was last read.
 */
export class ConflictError extends Error {
  constructor(resourceType: 'event' | 'contact' | 'invitation', detail?: string) {
    const message = [
      `The ${resourceType} was modified by another client since you last read it.`,
      '',
      'Fix: Please fetch the latest version and try your changes again.',
      detail || '',
    ]
      .filter((line) => line !== '')
      .join('\n');

    super(message);
    this.name = 'ConflictError';
  }
}

function davStatusAdvice(status: number): string {
  if (status === 401 || status === 403) {
    return 'Fix: The DAV server refused the credentials or the access. Check that the token or password is still valid.';
  }
  if (status === 413) {
    return 'Fix: The request is too large for the server. Ask for a narrower date range.';
  }
  if (status === 429 || status === 503) {
    return 'Fix: The DAV server is overloaded or rate limiting. Try again in a moment.';
  }
  return 'Fix: The DAV server failed on this request. Try again, or ask for a narrower date range.';
}

/**
 * The DAV server answered a read with an error. Never report this as an empty result.
 */
export class DavHttpError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(status: number, retryAfter: string | null = null, detail?: string) {
    // At startup tsdav tries other root URLs after a failure, and only keeps a first
    // error worded "Invalid credentials": otherwise a 401 ends up as what the next URL answers.
    super(
      `${status === 401 ? 'Invalid credentials: ' : ''}The DAV server answered HTTP ${status}${detail ? ` (${detail})` : ''}, so this result is unknown, not empty.\n\n${davStatusAdvice(status)}`
    );
    this.name = 'DavHttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Statuses of a server that does not offer a request, as opposed to one failing on it. */
const UNSUPPORTED_STATUSES = [400, 403, 404, 405, 415, 501];

export function isDavUnsupported(err: unknown): boolean {
  return err instanceof DavHttpError && UNSUPPORTED_STATUSES.includes(err.status);
}

/**
 * A PUT or DELETE got no answer. The server may have applied it, so repeating
 * it blindly can create a duplicate.
 */
export class DavWriteUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      'The DAV server did not confirm this change, so it may or may not have been applied.\n\nFix: Do not repeat it yet. First read the calendar or the address book to see whether it was applied.',
      { cause }
    );
    this.name = 'DavWriteUnknownError';
  }
}

/** fetch only says "fetch failed": the reason (ENOTFOUND, ECONNREFUSED, ...) is in its cause. */
export class DavNetworkError extends Error {
  constructor(cause: Error) {
    const reason = cause.cause as { code?: string; message?: string } | undefined;
    const detail = reason?.code ?? reason?.message;
    super(
      `The DAV server could not be reached${detail ? ` (${detail})` : ''}, so this result is unknown, not empty.\n\nFix: Check that the server is running and that DAV_URL is right.`,
      { cause }
    );
    this.name = 'DavNetworkError';
  }
}

export class DavTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The DAV server did not answer within ${timeoutMs / 1000} seconds, so this result is unknown, not empty.\n\nFix: Try again, or ask for a narrower date range.`
    );
    this.name = 'DavTimeoutError';
  }
}
