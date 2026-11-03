import { type FormDefinition, type FormField, newFormDefinition, newFormField } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FormRenderer } from '../components/forms/FormRenderer.tsx';

const field = (type: Parameters<typeof newFormField>[0], id: string, over: Record<string, unknown> = {}) =>
  ({ ...newFormField(type, id), ...over }) as FormField;

const def = (...fields: FormField[]): FormDefinition => ({
  ...newFormDefinition('Rental application'),
  settings: { ...newFormDefinition('Rental application').settings, description: 'Tell us about you.' },
  fields,
});

const setup = () => userEvent.setup({ applyAccept: false });

describe('FormRenderer', () => {
  it('shows the logo first, then the title and description', () => {
    const d = def(field('short_text', 'f_name0001', { label: 'Name' }));
    render(<FormRenderer definition={d} logoUrl="/api/forms/logos/abc" mode="preview" />);
    const form = screen.getByTestId('form-renderer');
    const first = form.querySelector('header')?.firstElementChild;
    expect(first?.tagName).toBe('IMG');
    expect(first).toHaveAttribute('src', '/api/forms/logos/abc');
    expect(screen.getByRole('heading', { name: 'Rental application' })).toBeInTheDocument();
    expect(screen.getByText('Tell us about you.')).toBeInTheDocument();
  });

  it('has no logo image without a logo', () => {
    render(<FormRenderer definition={def()} mode="preview" />);
    expect(screen.queryByTestId('form-logo')).toBeNull();
  });

  it('honours label, required, placeholder, help text and min/max', () => {
    const d = def(
      field('short_text', 'f_name0001', {
        label: 'Full name',
        required: true,
        placeholder: 'Jane',
        helpText: 'As on your ID',
      }),
      field('number', 'f_rooms001', { label: 'Rooms', min: 1, max: 10 }),
      field('date', 'f_move0001', { label: 'Move-in', min: '2026-01-01', max: '2026-12-31' }),
      field('dropdown', 'f_type0001', { label: 'Type', options: ['Flat', 'House'] }),
      field('radio', 'f_pets0001', { label: 'Pets', options: ['Yes', 'No'] }),
      field('checkbox', 'f_amen0001', { label: 'Extras', options: ['Parking', 'Storage'] }),
      field('file', 'f_id000001', {
        label: 'ID copy',
        allowedTypes: ['.pdf', '.png'],
        maxSizeBytes: 5 * 1024 * 1024,
      }),
    );
    render(<FormRenderer definition={d} mode="preview" />);
    const name = screen.getByLabelText(/Full name/);
    expect(name).toHaveAttribute('placeholder', 'Jane');
    expect(name).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('As on your ID')).toBeInTheDocument();
    const rooms = screen.getByLabelText('Rooms');
    expect(rooms).toHaveAttribute('type', 'number');
    expect(rooms).toHaveAttribute('min', '1');
    expect(rooms).toHaveAttribute('max', '10');
    const when = screen.getByLabelText('Move-in');
    expect(when).toHaveAttribute('type', 'date');
    expect(when).toHaveAttribute('min', '2026-01-01');
    expect(screen.getByRole('option', { name: 'House' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Storage' })).toBeInTheDocument();
    expect(screen.getByLabelText('ID copy')).toHaveAttribute('accept', '.pdf,.png');
    expect(screen.getByTestId('file-help-f_id000001')).toHaveTextContent('Allowed: PDF, PNG. Up to 5 MB.');
  });

  it('rejects an empty required field, a bad email and a number out of range with a message per field', async () => {
    const user = setup();
    const d = def(
      field('short_text', 'f_name0001', { label: 'Name', required: true }),
      field('email', 'f_mail0001', { label: 'Email' }),
      field('number', 'f_rooms001', { label: 'Rooms', min: 1, max: 10 }),
    );
    render(<FormRenderer definition={d} mode="preview" />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Rooms'), '11');
    await user.click(screen.getByTestId('form-submit'));
    expect(screen.getByTestId('error-f_name0001')).toHaveTextContent('This field is required.');
    expect(screen.getByTestId('error-f_mail0001')).toHaveTextContent('Enter a valid email address');
    expect(screen.getByTestId('error-f_rooms001')).toHaveTextContent('Enter a number between 1 and 10.');
    expect(screen.getByTestId('form-error-summary')).toHaveFocus();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('form-done')).toBeNull();
  });

  it('checks a field when it loses focus and clears the message once fixed', async () => {
    const user = setup();
    render(
      <FormRenderer definition={def(field('email', 'f_mail0001', { label: 'Email' }))} mode="preview" />,
    );
    const email = screen.getByLabelText('Email');
    await user.type(email, 'bad');
    await user.tab();
    expect(screen.getByTestId('error-f_mail0001')).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'a@b.co');
    expect(screen.queryByTestId('error-f_mail0001')).toBeNull();
  });

  it('rejects a disallowed file type and an over-size file, and accepts a good one', async () => {
    const user = setup();
    const d = def(
      field('file', 'f_id000001', { label: 'ID copy', allowedTypes: ['.pdf'], maxSizeBytes: 1024 * 1024 }),
    );
    render(<FormRenderer definition={d} mode="preview" />);
    const input = screen.getByLabelText('ID copy');
    await user.upload(input, new File(['x'], 'x.exe', { type: 'application/x-msdownload' }));
    expect(screen.getByTestId('error-f_id000001')).toHaveTextContent(
      'This file type is not allowed. Allowed: PDF.',
    );
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    await user.upload(input, big);
    expect(screen.getByTestId('error-f_id000001')).toHaveTextContent(
      'The file is too large (3 MB). The limit is 1 MB.',
    );
    await user.upload(input, new File(['x'], 'ok.pdf', { type: 'application/pdf' }));
    expect(screen.queryByTestId('error-f_id000001')).toBeNull();
  });

  it('shows the confirmation and says nothing was sent when the preview is valid', async () => {
    const user = setup();
    const d = def(field('short_text', 'f_name0001', { label: 'Name', required: true }));
    render(<FormRenderer definition={d} mode="preview" />);
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByTestId('form-submit'));
    expect(screen.getByTestId('form-confirmation')).toHaveTextContent(
      'Thank you. We have received your answers.',
    );
    expect(screen.getByText(/Preview only: nothing was sent/)).toBeInTheDocument();
  });

  it('renders labels as text, never as markup', () => {
    const d = def(field('short_text', 'f_name0001', { label: '<img src=x onerror=alert(1)>' }));
    const { container } = render(<FormRenderer definition={d} mode="preview" />);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });
});
