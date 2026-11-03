import { newFormDefinition, newFormField, validateFormAnswers, validateFormDefinition } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { logoContentType } from '../src/commands/forms.ts';

describe('shared form validation on the server side', () => {
  it('the server imports the same validation the builder preview uses', () => {
    const def = newFormDefinition('Rental');
    def.fields = [{ ...newFormField('email', 'f_email001'), required: true }];
    expect(validateFormDefinition(def).ok).toBe(true);
    expect(validateFormAnswers(def, { f_email001: 'bad' }).errors.f_email001?.code).toBe('invalid_email');
    expect(validateFormAnswers(def, { f_email001: 'a@b.co' }).ok).toBe(true);
  });

  it('recognises logos by their bytes only', () => {
    expect(logoContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png',
    );
    expect(logoContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(logoContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(logoContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(logoContentType(Buffer.alloc(0))).toBeNull();
  });
});
