import type { PublicApiError } from './api.ts';

export interface PublicMessage {
  text: string;
  /** The person can press "Try again" without retyping anything. */
  retry: boolean;
  /** Nothing the person does here will work (the form or link is closed). */
  closed: boolean;
}

const msg = (text: string, retry = false, closed = false): PublicMessage => ({ text, retry, closed });

/** An error code as a sentence for a client. No technical detail, nothing the server did not choose to say. */
export function describePublicError(e: Pick<PublicApiError, 'code' | 'status' | 'retryable'>): PublicMessage {
  switch (e.code) {
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
    case 'network':
      return msg('The connection was lost. Your answers are still here. Try again.', true);
    default:
      return msg('Something went wrong. Your answers are still here. Try again.', true);
  }
}
