import type { PublicApiError } from './api.ts';

export interface PublicMessage {
  text: string;
  /** The person can press "Try again" without retyping anything. */
  retry: boolean;
  /** Nothing the person does here will work (the form or link is closed). */
  closed: boolean;
}

const msg = (text: string, retry = false, closed = false): PublicMessage => ({ text, retry, closed });

/** Sentences the page shows on its own (not answers to a server error). */
export const PUBLIC_TEXT = {
  slowCheck:
    'Still checking your form. This can take a little longer on this device. Please keep this page open.',
  needsSecureLink:
    "This form can't be sent from this browser over this link. It needs a secure (https) link. Your answers are still here. Please contact the firm.",
  badOrigin:
    "This form can't be sent from this address. Please use the link the firm gave you, or contact the firm.",
} as const;

/** An error code as a sentence for a client. No technical detail, nothing the server did not choose to say. */
export function describePublicError(
  e: Pick<PublicApiError, 'code' | 'status' | 'retryable'> & { message?: string },
  /** What the submitter called the file (their own field label and file name), when the error says which one. */
  file?: string,
): PublicMessage {
  // The sentences about a secure link (the emailed link of the runner-offline flow) are the server's own.
  if (/^link_(expired|revoked|used)$/.test(e.code) && /secure link/.test(e.message ?? ''))
    return msg(e.message as string, false, true);
  switch (e.code) {
    case 'runner_online':
      return msg('The form can be sent now. Please reload the page.', false, true);
    case 'form_not_available':
      return msg('This form is not available.', false, true);
    case 'link_expired':
      return msg('This personal link has expired. Ask the firm for a new one.', false, true);
    case 'link_revoked':
      return msg('This personal link is no longer valid. Ask the firm for a new one.', false, true);
    case 'link_used':
      return msg('This personal link was already used to send this form.', false, true);
    case 'link_invalid':
      return msg('This personal link is not valid. Ask the firm for a new one.', false, true);
    case 'destination_missing':
      return msg("This form can't accept submissions. Please contact the firm.", false, true);
    case 'rate_limited':
      return msg('Too many attempts. Please wait a minute and try again.', true);
    case 'runner_offline':
      return msg(
        "This form can't accept submissions right now. Please try again later. Your answers are still here.",
        true,
      );
    case 'malware_detected':
      return msg(
        `One of your files${file ? ` (${file})` : ''} could not be accepted because it failed a security check. Please check the file and try again, or contact the firm.`,
      );
    case 'scan_unavailable':
      return msg('Your submission could not be checked right now. Please try again later.', true);
    case 'storage_failed':
      return e.retryable
        ? msg(
            "We couldn't save your form to the firm's storage. Your answers are still here. Try again.",
            true,
          )
        : msg("We couldn't save your form. Please contact the firm.", false, true);
    case 'file_too_large':
      return msg('A file is too large. Choose a smaller file and send again.');
    case 'file_type_refused':
      return msg('One of the files is not an accepted type. Choose a different file and send again.');
    case 'invalid_answers':
    case 'too_many_files':
      return msg('Some answers need attention. Please check the form and send again.');
    case 'submission_refused':
      return msg('We could not accept this submission. Please try again.', true);
    // raised by the page itself: this browser cannot do the check the form needs before sending
    case 'pow_unsupported':
      return msg(PUBLIC_TEXT.needsSecureLink);
    // the page was opened at an address the server does not accept (a configuration matter)
    case 'bad_origin':
      return msg(PUBLIC_TEXT.badOrigin);
    case 'network':
      return msg('The connection was lost. Your answers are still here. Try again.', true);
    default:
      return msg('Something went wrong. Your answers are still here. Try again.', true);
  }
}
