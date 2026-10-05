/** Provider-neutral inbound mail contracts. This module does not claim that a provider is configured. */
export interface InboundEmailAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface InboundEmailMessage {
  providerMessageId: string;
  senderAddress: string;
  subject: string;
  receivedAt: string;
  attachments: InboundEmailAttachment[];
}

export interface EmailImportConfiguration {
  configured: boolean;
  providerName?: string;
  allowedSenders: string[];
  allowedDomains: string[];
  allowedAttachmentTypes: string[];
  maximumAttachmentBytes: number;
}

export interface QuarantinedEmailImport {
  id: string;
  messageId: string;
  receivedAt: string;
  senderAddress: string;
  subject: string;
  status: 'quarantined' | 'previewed' | 'approved' | 'rejected';
  reason?: 'provider_unconfigured' | 'sender_not_allowed' | 'attachment_not_allowed' | 'attachment_too_large' | 'duplicate_message';
  attachmentCount: number;
  approvedBy?: string;
  approvedAt?: string;
  auditReference: string;
}

export const EMAIL_INGESTION_UNCONFIGURED: EmailImportConfiguration = {
  configured: false,
  allowedSenders: [],
  allowedDomains: [],
  allowedAttachmentTypes: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  maximumAttachmentBytes: 10 * 1024 * 1024,
};

export type EmailQuarantineDecision = { accepted: true } | { accepted: false; reason: NonNullable<QuarantinedEmailImport['reason']> };

/** Check trust policy only; callers must still parse, validate and require explicit approval. */
export function validateInboundEmail(message: InboundEmailMessage, config: EmailImportConfiguration, seenMessageIds: ReadonlySet<string>): EmailQuarantineDecision {
  if (!config.configured) return { accepted: false, reason: 'provider_unconfigured' };
  if (!message.providerMessageId || seenMessageIds.has(message.providerMessageId)) return { accepted: false, reason: 'duplicate_message' };
  const sender = message.senderAddress.trim().toLocaleLowerCase();
  const domain = sender.split('@').at(-1) || '';
  const allowed = config.allowedSenders.map(value => value.toLocaleLowerCase()).includes(sender) ||
    config.allowedDomains.map(value => value.toLocaleLowerCase()).includes(domain);
  if (!allowed) return { accepted: false, reason: 'sender_not_allowed' };
  if (message.attachments.some(attachment => !config.allowedAttachmentTypes.includes(attachment.contentType))) return { accepted: false, reason: 'attachment_not_allowed' };
  if (message.attachments.some(attachment => attachment.bytes.byteLength > config.maximumAttachmentBytes)) return { accepted: false, reason: 'attachment_too_large' };
  return { accepted: true };
}
