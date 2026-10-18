import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { StatusBadge } from '../status-badge';
import { Drawer } from '../drawer';

describe('Drawer and StatusBadge Components', () => {
  it('renders StatusBadge with clinical color tokens', () => {
    const html = renderToString(<StatusBadge status="Ready for discharge" variant="green" />);
    expect(html).toContain('Ready for discharge');
    expect(html).toContain('emerald');
  });

  it('renders Drawer with patient context header (Name + UHID + Bed)', () => {
    const html = renderToString(
      <Drawer
        isOpen={true}
        onClose={() => {}}
        title="Assess Allergies"
        patient={{ name: 'Raj Patil', uhid: 'UHID-1042', bedLabel: 'Bed 2' }}
      >
        <p>Drawer Body</p>
      </Drawer>,
    );
    expect(html).toContain('Assess Allergies');
    expect(html).toContain('Raj Patil');
    expect(html).toContain('UHID-1042');
    expect(html).toContain('Bed 2');
    expect(html).toContain('Drawer Body');
  });
});
