import type { RelayIntegrationDto } from '@aom/shared';
import { relayServeCommand, relayWhatsAppCommand } from '../../lib/relay.ts';
import { CopyButton } from '../delivery/connect/CopyButton.tsx';

function Command({ text, testId }: { text: string; testId: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <code
        className="min-w-0 select-all break-all rounded bg-sunken px-2 py-1 font-mono text-xs"
        data-testid={testId}
      >
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * How to start receiving an inbound webhook. Provider secrets (Meta app secret, verify token) are entered on the
 * workstation with the runner command, never in the browser: this page has no field for them.
 * `addressKnown` is true right after create/rotate (the address is on screen); later it is no longer available.
 */
export function RelaySetupSteps({
  integration,
  addressKnown,
}: {
  integration: Pick<RelayIntegrationDto, 'id' | 'kind'>;
  addressKnown: boolean;
}) {
  const whatsapp = integration.kind === 'whatsapp_cloud';
  return (
    <ol className="list-decimal space-y-3 pl-5 text-sm text-muted" data-testid="relay-setup-steps">
      <li>
        <span className="font-medium text-fg">Serve it from your workstation.</span> On the workstation that
        runs your runner (signed in as an Owner or Admin), run this command, then restart the runner:
        <Command text={relayServeCommand(integration)} testId="relay-serve-command" />
      </li>
      {whatsapp ? (
        <>
          <li>
            In Meta for Developers, open your app, then WhatsApp, Configuration, Webhook. Paste{' '}
            {addressKnown ? 'the address above' : 'the address you copied when you created or rotated it'} as
            the <strong>Callback URL</strong>.
          </li>
          <li>
            Choose a <strong>verify token</strong> yourself. You type it in Meta and on your workstation,
            never here.
          </li>
          <li>
            On that workstation, enter the app secret and the verify token with this command. They are stored
            encrypted on that workstation and never reach Guildwise HQ:
            <Command text={relayWhatsAppCommand(integration)} testId="relay-whatsapp-command" />
          </li>
          <li>
            Click <strong>Verify and save</strong> in Meta. Your runner answers Meta's check through Guildwise
            HQ, then subscribe to the <strong>messages</strong> field.
          </li>
        </>
      ) : (
        <li>Paste the address as the webhook URL at the provider.</li>
      )}
    </ol>
  );
}
