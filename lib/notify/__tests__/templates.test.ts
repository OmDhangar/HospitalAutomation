import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/lib/i18n/patient';
import { CRITICAL_TEMPLATES, TEMPLATES, isCritical, renderTemplate } from '../templates';

/**
 * Guards on the template set itself.
 *
 * Templates are approved by Meta per name and per language, and editing one
 * returns it to review — during which every send against it fails. That makes
 * these the most expensive strings in the codebase to get wrong, and the
 * cheapest to check before submitting.
 */

const CODES = Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>;

describe('template completeness', () => {
  it('has every locale for every template', () => {
    for (const code of CODES) {
      for (const locale of LOCALES) {
        expect(TEMPLATES[code].body[locale], `${code}/${locale}`).toBeTruthy();
      }
    }
  });

  it('declares a variable count matching the {{n}} in every locale', () => {
    /**
     * A body whose highest placeholder disagrees with `variables` is a send
     * that fails with Meta error 132000, and it fails only in the locale that
     * drifted — so it survives testing in English and breaks for Marathi
     * patients in production.
     */
    for (const code of CODES) {
      const declared = TEMPLATES[code].variables.length;

      for (const locale of LOCALES) {
        const found = [...TEMPLATES[code].body[locale].matchAll(/\{\{(\d+)\}\}/g)].map((m) =>
          Number(m[1]),
        );
        const highest = found.length > 0 ? Math.max(...found) : 0;
        expect(highest, `${code}/${locale} highest placeholder`).toBe(declared);

        // Every index from 1..declared must actually appear.
        for (let i = 1; i <= declared; i += 1) {
          expect(found, `${code}/${locale} missing {{${i}}}`).toContain(i);
        }
      }
    }
  });

  it('never starts or ends a body with a variable', () => {
    // Meta rejects both outright.
    for (const code of CODES) {
      for (const locale of LOCALES) {
        const body = TEMPLATES[code].body[locale].trim();
        expect(body.startsWith('{{'), `${code}/${locale} starts with a variable`).toBe(false);
        expect(body.endsWith('}}'), `${code}/${locale} ends with a variable`).toBe(false);
      }
    }
  });

  it('keeps button labels inside Meta’s 25-character cap', () => {
    for (const code of CODES) {
      const button = TEMPLATES[code].urlButton;
      if (!button) continue;
      for (const locale of LOCALES) {
        expect(button.label[locale].length, `${code}/${locale} button label`).toBeLessThanOrEqual(
          25,
        );
      }
    }
  });

  it('keeps quick replies inside the 25-character cap, in every locale', () => {
    for (const code of CODES) {
      const replies = TEMPLATES[code].quickReplies;
      if (!replies) continue;
      for (const locale of LOCALES) {
        expect(replies[locale].length, `${code}/${locale} has no quick reply`).toBeGreaterThan(0);
        for (const reply of replies[locale]) {
          expect(reply.length, `${code}/${locale} "${reply}"`).toBeLessThanOrEqual(25);
        }
      }
    }
  });

  it('gives every template a distinct Meta name', () => {
    const names = CODES.map((code) => TEMPLATES[code].name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('what is treated as critical', () => {
  it('protects every message whose absence causes a wasted journey', () => {
    // The test for criticality is whether skipping it strands somebody, not
    // whether it is nice to receive.
    expect(isCritical('queue_link')).toBe(true);
    expect(isCritical('appointment_confirmed')).toBe(true);
    expect(isCritical('slot_reminder')).toBe(true);
    expect(isCritical('slot_disrupted')).toBe(true);
    expect(isCritical('queue_skipped')).toBe(true);
    expect(isCritical('appointment_cancelled')).toBe(true);
  });

  it('leaves the queue nudge droppable', () => {
    // A missed "you are nearly next" costs a convenience; it is the only
    // patient message that may be suppressed to protect margin.
    expect(isCritical('queue_milestone')).toBe(false);
  });

  it('references only templates that exist', () => {
    for (const code of CRITICAL_TEMPLATES) {
      expect(TEMPLATES[code], `critical set names unknown template ${code}`).toBeDefined();
    }
  });
});

describe('renderTemplate', () => {
  it('fills every placeholder for the new appointment confirmation', () => {
    const text = renderTemplate(
      'appointment_confirmed',
      'en',
      ['Mehta', '24 Sep', '10:30 AM', '42'],
      'abc123',
    );

    expect(text).toContain('Mehta');
    expect(text).toContain('24 Sep');
    expect(text).toContain('10:30 AM');
    expect(text).toContain('42');
    // The old queue wording said nothing about when the appointment was.
    expect(text).not.toContain('{{');
  });

  it('leaves no placeholder unfilled in any template or locale', () => {
    for (const code of CODES) {
      const definition = TEMPLATES[code];
      const variables = definition.variables.map((_, i) => `v${i + 1}`);

      for (const locale of LOCALES) {
        const text = renderTemplate(code, locale, variables, 'suffix');
        expect(text, `${code}/${locale}`).not.toMatch(/\{\{\d+\}\}/);
      }
    }
  });
});
