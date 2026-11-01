/**
 * Prior approval of every write, asked by the server itself through MCP elicitation: the client shows
 * the user the exact action (event, dates, attendees who will be notified, contact) and the server acts
 * only on an explicit "accept". Fail closed: a client that cannot ask, a refusal, a timeout or an error
 * means nothing is written.
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type ApprovalMode = 'elicit' | 'client';
export type Language = 'en' | 'fr';

const ACTIONS = {
  create_event: { en: 'Create an event', fr: 'Créer un événement' },
  update_event: { en: 'Change an event', fr: 'Modifier un événement' },
  update_occurrence: { en: 'Change one occurrence of a recurring event', fr: "Modifier une occurrence d'un événement récurrent" },
  delete_event: { en: 'Delete an event (cannot be undone)', fr: 'Supprimer un événement (définitif)' },
  delete_occurrence: { en: 'Delete one occurrence of a recurring event', fr: "Supprimer une occurrence d'un événement récurrent" },
  add_alarm: { en: 'Add a reminder', fr: 'Ajouter un rappel' },
  remove_alarm: { en: 'Remove a reminder', fr: 'Retirer un rappel' },
  respond_to_invitation: { en: 'Answer an invitation', fr: 'Répondre à une invitation' },
  create_contact: { en: 'Create a contact', fr: 'Créer un contact' },
  update_contact: { en: 'Change a contact', fr: 'Modifier un contact' },
  delete_contact: { en: 'Delete a contact (no bin: cannot be undone)', fr: 'Supprimer un contact (pas de corbeille : définitif)' },
} as const;

const LABELS = {
  en: {
    as: 'As', calendar: 'Calendar', addressbook: 'Address book', event: 'Event', title: 'Title', when: 'When', location: 'Location',
    description: 'Description', recurrence: 'Repeats', attendees: 'Invited', notified: 'Notified', reminder: 'Reminder', answer: 'Answer',
    organizer: 'Organizer', contact: 'Contact', name: 'Name', email: 'Email', phone: 'Phone', organization: 'Organization', changes: 'Changes',
    occurrence: 'Occurrence', all_day: 'all day', account: 'your account', ref: 'Ref.', footer: 'Accept to do it now, refuse to cancel.',
    invitation_sent: 'they receive an invitation sent in your name', update_sent: 'the server may send them the change',
    cancel_sent: 'the server may send them a cancellation', reply_sent: 'the organizer receives your answer',
    accepted: 'accept', declined: 'decline', tentative: 'maybe', all: 'all',
  },
  fr: {
    as: 'En tant que', calendar: 'Agenda', addressbook: "Carnet d'adresses", event: 'Événement', title: 'Titre', when: 'Quand', location: 'Lieu',
    description: 'Description', recurrence: 'Récurrence', attendees: 'Invités', notified: 'Prévenus', reminder: 'Rappel', answer: 'Réponse',
    organizer: 'Organisateur', contact: 'Contact', name: 'Nom', email: 'E-mail', phone: 'Téléphone', organization: 'Organisation', changes: 'Changements',
    occurrence: 'Occurrence', all_day: 'journée entière', account: 'votre compte', ref: 'Réf.', footer: 'Acceptez pour le faire maintenant, refusez pour annuler.',
    invitation_sent: 'ils reçoivent une invitation envoyée en votre nom', update_sent: 'le serveur peut leur envoyer la modification',
    cancel_sent: 'le serveur peut leur envoyer une annulation', reply_sent: "l'organisateur reçoit votre réponse",
    accepted: 'accepter', declined: 'refuser', tentative: 'peut-être', all: 'tous',
  },
} as const;

export type Action = keyof typeof ACTIONS;
export type Label = keyof (typeof LABELS)['en'];

export interface ApprovalRequest {
  action: Action;
  /** [label key, value]; undefined or empty values are left out. */
  details: [Label, string | undefined][];
}

export interface ApprovalOptions {
  mode: ApprovalMode;
  language: Language;
  timeoutMs: number;
  /** Who the writes are made as, e.g. the organizer name or the account e-mail. */
  as?: string;
  timeZone?: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function approvalMessage(req: ApprovalRequest, opts: Pick<ApprovalOptions, 'language' | 'as'>, ref: string): string {
  const L = LABELS[opts.language];
  const sep = opts.language === 'fr' ? ' : ' : ': ';
  const lines = [`Twake Calendar${sep}${ACTIONS[req.action][opts.language]}`];
  if (opts.as) lines.push(`${L.as}${sep}${opts.as} (${L.account})`);
  for (const [label, value] of req.details) {
    if (value === undefined || value === '') continue;
    lines.push(value.includes('\n') ? `${L[label]}${sep}\n${value}` : `${L[label]}${sep}${value}`);
  }
  lines.push('', `${L.ref} ${ref} · ${L.footer}`);
  return lines.join('\n');
}

export class Approver {
  constructor(
    private readonly server: Server,
    readonly opts: ApprovalOptions,
  ) {}

  label(key: Label): string {
    return LABELS[this.opts.language][key];
  }

  /** `YYYY-MM-DD HH:mm` (or the date alone for all-day events) in the user's time zone. */
  date(d: Date, allDay = false): string {
    const tz = this.opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: allDay ? undefined : tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    );
    return allDay ? `${p.year}-${p.month}-${p.day}` : `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  /** Start → end, the end shortened when on the same day, with the time zone. */
  span(start: Date, end: Date, allDay = false): string {
    if (allDay) {
      const last = new Date(end.getTime() - 86400000);
      const a = this.date(start, true);
      const b = this.date(last < start ? start : last, true);
      return `${a === b ? a : `${a} → ${b}`} (${this.label('all_day')})`;
    }
    const a = this.date(start);
    const b = this.date(end);
    const tz = this.opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${a} → ${b.slice(0, 10) === a.slice(0, 10) ? b.slice(11) : b} (${tz})`;
  }

  /** One line naming an event: title · when. */
  eventLine(e: { summary: string; startDate: Date; endDate: Date; allDay?: boolean }): string {
    return `${e.summary} · ${this.span(e.startDate, e.endDate, Boolean(e.allDay))}`;
  }

  /** Attendees who will be notified, with the reason. */
  notified(people: string[], why: 'invitation_sent' | 'update_sent' | 'cancel_sent'): string | undefined {
    return people.length ? `${people.join(', ')} (${this.label(why)})` : undefined;
  }

  /**
   * Ask the user. Returns null when they accepted (go ahead), or the tool result to send back
   * when nothing must be written.
   */
  async gate(req: ApprovalRequest): Promise<ToolResult | null> {
    if (this.opts.mode === 'client') return null;
    if (!this.server.getClientCapabilities()?.elicitation) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Not done: this MCP client cannot ask the user for approval (no elicitation support), so mcp-twake-dav refuses to write. ' +
              'Use a client that supports elicitation, or set DAV_APPROVAL=client only if the client itself confirms every write tool with the user.',
          },
        ],
        isError: true,
      };
    }
    const ref = randomBytes(3).toString('hex');
    let action = 'cancel';
    try {
      const res = await this.server.elicitInput(
        { mode: 'form', message: approvalMessage(req, this.opts, ref), requestedSchema: { type: 'object', properties: {} } },
        { timeout: this.opts.timeoutMs },
      );
      action = res.action;
    } catch {
      action = 'cancel';
    }
    if (action === 'accept') return null;
    return {
      content: [
        {
          type: 'text',
          text:
            action === 'decline'
              ? 'Not done: the user refused this action, nothing was changed. Do not retry unless they ask again.'
              : 'Not done: no answer to the approval request (dismissed, timed out or nobody available), nothing was changed. Do not retry on your own.',
        },
      ],
    };
  }
}

const approvers = new WeakMap<McpServer, Approver>();

export function setApprover(server: McpServer, opts: ApprovalOptions): Approver {
  const a = new Approver(server.server, opts);
  approvers.set(server, a);
  return a;
}

/** The server's approver; one that was never configured asks with the defaults (fail closed). */
export function approverFor(server: McpServer): Approver {
  let a = approvers.get(server);
  if (!a) a = setApprover(server, { mode: 'elicit', language: 'en', timeoutMs: 600_000 });
  return a;
}
