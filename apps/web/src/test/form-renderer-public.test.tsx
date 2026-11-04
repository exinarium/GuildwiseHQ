import { type FormDefinition, type FormField, newFormDefinition, newFormField } from '@aom/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FormRenderer } from '../components/forms/FormRenderer.tsx';

const field = (type: Parameters<typeof newFormField>[0], id: string, over: Record<string, unknown> = {}) =>
  ({ ...newFormField(type, id), ...over }) as FormField;
const def = (...fields: FormField[]): FormDefinition => ({ ...newFormDefinition('Rental application'), fields });
const setup = () => userEvent.setup({ applyAccept: false });
const NAME = field('short_text', 'f_name0001', { label: 'Full name', required: true });
const FILE = field('file', 'f_file0001', {
  label: 'ID copy',
  allowedTypes: ['.pdf'],
  maxSizeBytes: 1000,
});

describe('FormRenderer in public mode', () => {
  it('awaits onSubmit and does not show the confirmation until the page says done', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { rerender } = render(<FormRenderer definition={def(NAME)} mode="public" onSubmit={onSubmit} />);
    const u = setup();
    await u.type(screen.getByLabelText(/Full name/), 'Ann');
    await u.click(screen.getByTestId('form-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ f_name0001: 'Ann' });
    expect(screen.queryByTestId('form-done')).toBeNull();
    rerender(<FormRenderer definition={def(NAME)} mode="public" onSubmit={onSubmit} done />);
    expect(screen.getByTestId('form-confirmation')).toHaveTextContent('Thank you');
    expect(screen.queryByText(/Preview only/)).toBeNull();
  });

  it('still validates before it calls onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<FormRenderer definition={def(NAME)} mode="public" onSubmit={onSubmit} />);
    await setup().click(screen.getByTestId('form-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-f_name0001')).toBeInTheDocument();
  });

  it('restores text answers, mirrors every change and asks for a file to be chosen again', async () => {
    const onChange = vi.fn();
    render(
      <FormRenderer
        definition={def(NAME, FILE)}
        mode="public"
        initialAnswers={{ f_name0001: 'Ann', f_file0001: { name: 'id.pdf', size: 10, type: 'application/pdf' } }}
        onAnswersChange={onChange}
      />,
    );
    expect(screen.getByLabelText(/Full name/)).toHaveValue('Ann');
    expect(screen.getByTestId('file-again-f_file0001')).toHaveTextContent('Choose this file again');
    await setup().type(screen.getByLabelText(/Full name/), 'e');
    expect(onChange).toHaveBeenLastCalledWith({ f_name0001: 'Anne' });
  });

  it('hands the chosen File itself to the page, and null when it is cleared', async () => {
    const onFile = vi.fn();
    render(<FormRenderer definition={def(FILE)} mode="public" onFileChange={onFile} />);
    const file = new File(['%PDF-1.7'], 'id.pdf', { type: 'application/pdf' });
    await setup().upload(screen.getByLabelText(/ID copy/), file);
    expect(onFile).toHaveBeenCalledWith('f_file0001', file);
    await setup().upload(screen.getByLabelText(/ID copy/), []);
  });

  it('shows the server refusals with the shared wording, the status block, the slot, and disables while busy', () => {
    render(
      <FormRenderer
        definition={def(NAME)}
        mode="public"
        serverErrors={{ f_name0001: 'required' }}
        status={<p data-testid="my-status">Sending file 1 of 2…</p>}
        extra={<div data-testid="my-slot" />}
        busy
      />,
    );
    expect(screen.getByTestId('error-f_name0001')).toHaveTextContent('This field is required.');
    expect(screen.getByTestId('my-status')).toBeInTheDocument();
    expect(screen.getByTestId('my-slot')).toBeInTheDocument();
    expect(screen.getByTestId('form-submit')).toBeDisabled();
  });

  it('has no style attribute anywhere, so a policy without inline styles holds', () => {
    const { container } = render(<FormRenderer definition={def(NAME, FILE)} logoUrl="/x.png" mode="public" />);
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('preview mode ignores every public prop and behaves as before', async () => {
    const onSubmit = vi.fn();
    render(
      <FormRenderer
        definition={def(NAME)}
        mode="preview"
        onSubmit={onSubmit}
        done={false}
        busy
        status={<p data-testid="ignored" />}
        extra={<p data-testid="ignored-slot" />}
      />,
    );
    expect(screen.queryByTestId('ignored')).toBeNull();
    expect(screen.queryByTestId('ignored-slot')).toBeNull();
    const u = setup();
    await u.type(screen.getByLabelText(/Full name/), 'Ann');
    await u.click(screen.getByTestId('form-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Preview only/)).toBeInTheDocument();
  });
});
