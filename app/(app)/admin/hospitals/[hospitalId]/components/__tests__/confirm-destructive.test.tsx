import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ConfirmDestructiveModal, ConfirmModal } from '@/components/confirm-destructive';

describe('ConfirmDestructiveModal', () => {
  it('renders nothing when isOpen is false', () => {
    const html = renderToString(
      <ConfirmDestructiveModal
        isOpen={false}
        onClose={() => {}}
        title="Revoke plan?"
        description={['Consequence 1', 'Consequence 2']}
        confirmWord="REVOKE"
        submitLabel="Revoke plan"
        onConfirm={async () => ({ ok: true })}
      />,
    );
    expect(html).toBe('');
  });

  it('renders title, consequences, and disabled submit button when open', () => {
    const html = renderToString(
      <ConfirmDestructiveModal
        isOpen={true}
        onClose={() => {}}
        title="Revoke plan?"
        description={['Sign out every staff member', 'Stop online bookings']}
        confirmWord="REVOKE"
        submitLabel="Revoke plan"
        onConfirm={async () => ({ ok: true })}
      />,
    );
    expect(html).toContain('Revoke plan?');
    expect(html).toContain('Sign out every staff member');
    expect(html).toContain('Stop online bookings');
    expect(html).toContain('Type REVOKE to confirm');
    expect(html).toContain('disabled');
  });

  it('renders ConfirmModal with description and submit button', () => {
    const html = renderToString(
      <ConfirmModal
        isOpen={true}
        onClose={() => {}}
        title="Support access?"
        description="Reason required to view hospital."
        submitLabel="Continue"
        onConfirm={async () => {}}
      />,
    );
    expect(html).toContain('Support access?');
    expect(html).toContain('Reason required to view hospital.');
    expect(html).toContain('Continue');
  });
});
