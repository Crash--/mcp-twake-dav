/**
 * Invitation transformer
 *
 * Reads what a calendar object asks of the current user. An object can hold a master
 * and several exceptions, each with its own attendees and PARTSTAT, or an exception
 * alone for someone invited to a single occurrence.
 */

import ICAL from 'ical.js';
import type { Logger } from 'pino';
import type { InvitationDTO } from '../types/dtos.js';
import { expandRecurringEvent } from './recurrence.js';
import { icalTimeToDate, registerTimezones } from './timezone.js';

/**
 * Raw response from tsdav calendarQuery
 */
export interface InboxResponse {
  href: string;
  props?: {
    getetag?: string;
    calendarData?: string;
  };
}

export interface InvitationOptions {
  /** Keep what happens in this range, with a series shown at its next occurrence there */
  timeRange?: { start: string; end: string };
  userTimezone?: string;
}

function findAttendee(vevent: ICAL.Component, userEmails: string[]): { email: string; partstat: string } | null {
  for (const attendee of vevent.getAllProperties('attendee')) {
    const value = attendee.getFirstValue();
    if (typeof value !== 'string') continue;
    const email = value.replace(/^mailto:/i, '').toLowerCase();
    if (userEmails.includes(email)) {
      const partstat = attendee.getParameter('partstat');
      return { email, partstat: (typeof partstat === 'string' ? partstat : 'NEEDS-ACTION').toUpperCase() };
    }
  }
  return null;
}

/**
 * Transform a calendar object into one invitation per VEVENT the current user attends,
 * leaving out what was cancelled.
 *
 * @param response - Raw response from calendarQuery
 * @param userEmails - Current user's lowercase emails to match in ATTENDEE list
 * @param logger - Pino logger for error/debug output
 * @returns The invitations of this object
 * @throws Error if the object cannot be parsed
 */
export function transformInvitations(
  response: InboxResponse,
  userEmails: string[],
  logger: Logger,
  options: InvitationOptions = {},
): InvitationDTO[] {
  const calendarData = response.props?.calendarData;
  if (!calendarData) {
    throw new Error('no calendar data');
  }

  const comp = new ICAL.Component(ICAL.parse(calendarData));
  registerTimezones(comp, logger);

  const vevents = comp.getAllSubcomponents('vevent');
  const exceptions = vevents.filter((v: ICAL.Component) => v.hasProperty('recurrence-id'));
  const { timeRange, userTimezone } = options;
  const rangeStart = timeRange ? new Date(timeRange.start) : null;
  const rangeEnd = timeRange ? new Date(timeRange.end) : null;
  const exceptionTimes = new Set(
    exceptions.map((v: ICAL.Component) => {
      const recurrenceId = new ICAL.Event(v).recurrenceId;
      return recurrenceId ? icalTimeToDate(recurrenceId, userTimezone).getTime() : 0;
    })
  );

  const invitations: InvitationDTO[] = [];
  for (const vevent of vevents) {
    const status = vevent.getFirstPropertyValue('status');
    if (status && String(status).toUpperCase() === 'CANCELLED') continue;

    const attendee = findAttendee(vevent, userEmails);
    if (!attendee) continue;

    const event = new ICAL.Event(vevent);
    if (!event.uid) {
      logger.warn({ href: response.href }, 'VEVENT missing UID');
      continue;
    }

    let proposedStart = icalTimeToDate(event.startDate, userTimezone);
    let proposedEnd = icalTimeToDate(event.endDate, userTimezone);
    const isOccurrence = vevent.hasProperty('recurrence-id');
    if (rangeStart && rangeEnd) {
      if (vevent.hasProperty('rrule')) {
        // A series that began in 2020 is asked about at its next date, not at its first.
        const duration = proposedEnd.getTime() - proposedStart.getTime();
        const next = expandRecurringEvent(vevent, {
          maxOccurrences: exceptions.length + 1,
          maxDate: rangeEnd,
          startDate: rangeStart,
          userTimezone,
        }).find((date) => date < rangeEnd && !exceptionTimes.has(date.getTime()));
        if (!next) continue;
        proposedStart = next;
        proposedEnd = new Date(next.getTime() + duration);
      } else if (proposedStart >= rangeEnd || (proposedEnd <= rangeStart && proposedStart < rangeStart)) {
        continue;
      }
    }

    const organizerProp = vevent.getFirstProperty('organizer');
    const cn = organizerProp?.getParameter('cn');
    const organizerValue = organizerProp?.getFirstValue();
    const organizerEmail = typeof organizerValue === 'string' ? organizerValue.replace(/^mailto:/i, '') : '';

    invitations.push({
      uid: event.uid,
      summary: event.summary || '(No title)',
      organizer: {
        name: (typeof cn === 'string' ? cn : undefined) || 'Unknown',
        email: organizerEmail,
      },
      userIsOrganizer: userEmails.includes(organizerEmail.toLowerCase()),
      hasExceptions: exceptions.length > 0,
      proposedStart,
      proposedEnd,
      location: event.location || undefined,
      userPartstat: attendee.partstat,
      attendeeEmail: attendee.email,
      isOccurrence,
      url: response.href,
      etag: response.props?.getetag || '',
      _raw: calendarData,
    });
  }
  return invitations;
}
