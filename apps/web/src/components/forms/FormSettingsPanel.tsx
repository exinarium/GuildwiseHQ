import { FORM_LIMITS, type FormDefinition, type FormDefinitionIssue, formLogoUrl } from '@aom/shared';
import { useRef, useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { type StorageConnectionOption, uploadFormLogo } from '../../api/queries/forms.ts';
import { Button, TextArea, TextInput } from '../ui.tsx';
import { DestinationInputs, issueFor } from './FieldProperties.tsx';

/** The form-level settings: title, description, logo, destination of the text answers, confirmation text. */
export function FormSettingsPanel({
  settings,
  onChange,
  connections,
  issues,
  disabled,
}: {
  settings: FormDefinition['settings'];
  onChange: (s: FormDefinition['settings']) => void;
  connections: readonly StorageConnectionOption[];
  issues: readonly FormDefinitionIssue[];
  disabled?: boolean;
}) {
  const [logoError, setLogoError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setLogoError(undefined);
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
      setLogoError('Use a PNG, JPEG or WebP image.');
      return;
    }
    if (f.size > FORM_LIMITS.logoBytes) {
      setLogoError('The logo is too large. Use an image of 512 KB or less.');
      return;
    }
    setBusy(true);
    try {
      const out = await uploadFormLogo(f);
      onChange({ ...settings, logo: { imageId: out.imageId, alt: settings.logo?.alt ?? '' } });
    } catch (e) {
      setLogoError(errorMessage(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="form-settings">
      <h2 className="text-sm font-semibold text-fg">Form settings</h2>
      <TextInput
        id="form-title"
        label="Title"
        disabled={disabled}
        value={settings.title}
        maxLength={FORM_LIMITS.label}
        error={settings.title.trim() === '' ? 'Enter a title.' : issueFor(issues, 'settings.title')}
        onChange={(e) => onChange({ ...settings, title: e.target.value })}
      />
      <TextArea
        id="form-description"
        label="Description"
        disabled={disabled}
        value={settings.description}
        maxLength={FORM_LIMITS.description}
        onChange={(e) => onChange({ ...settings, description: e.target.value })}
      />
      <div className="flex flex-col gap-2">
        <label htmlFor="form-logo-file" className="text-sm font-medium text-fg">
          Company logo
        </label>
        {settings.logo && (
          <img
            src={formLogoUrl(settings.logo.imageId)}
            alt={settings.logo.alt || 'Company logo'}
            className="max-h-20 w-auto self-start rounded-control border border-line object-contain"
            data-testid="logo-thumb"
          />
        )}
        <input
          ref={file}
          id="form-logo-file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={disabled || busy}
          className="text-sm"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <p className="text-xs text-subtle">PNG, JPEG or WebP, up to 512 KB.</p>
        {logoError && (
          <p role="alert" className="text-sm font-medium text-danger" data-testid="logo-error">
            {logoError}
          </p>
        )}
        {settings.logo && (
          <>
            <TextInput
              id="form-logo-alt"
              label="Logo description (alt text)"
              disabled={disabled}
              value={settings.logo.alt}
              maxLength={FORM_LIMITS.label}
              onChange={(e) =>
                settings.logo && onChange({ ...settings, logo: { ...settings.logo, alt: e.target.value } })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              disabled={disabled}
              onClick={() => onChange({ ...settings, logo: null })}
            >
              Remove logo
            </Button>
          </>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg">Where the text answers go</legend>
        <DestinationInputs
          idPrefix="answers-dest"
          value={settings.answersDestination}
          connections={connections}
          issues={issues}
          issuePrefix="settings.answersDestination"
          disabled={disabled}
          onChange={(d) => onChange({ ...settings, answersDestination: d })}
        />
      </fieldset>
      <TextInput
        id="form-offline-link-days"
        label="Secure link expiry when your runner is offline (days)"
        type="number"
        inputMode="numeric"
        min={1}
        max={30}
        disabled={disabled}
        value={settings.offlineLinkDays ?? ''}
        hint="Clients who tried the form while your runner was offline get a secure link that works once. Default 7 days."
        onChange={(e) => {
          const { offlineLinkDays: _drop, ...rest } = settings;
          const n = Number.parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) ? { ...rest, offlineLinkDays: Math.min(30, Math.max(1, n)) } : rest);
        }}
      />
      <TextArea
        id="form-confirmation"
        label="Confirmation text"
        disabled={disabled}
        value={settings.confirmationText}
        maxLength={FORM_LIMITS.confirmation}
        error={
          settings.confirmationText.trim() === ''
            ? 'Enter the text clients see after they submit.'
            : undefined
        }
        onChange={(e) => onChange({ ...settings, confirmationText: e.target.value })}
      />
    </div>
  );
}
