'use client';

import { useState } from 'react';
import { Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { ConfirmModal } from '@/components/confirm-destructive';
import { DefinitionRow } from '../../../ui';
import { updateProfileAction } from '../actions';
import type { AccountRow } from '@/lib/services/platform-accounts';

export function ProfileCard({
  account,
  branches = [],
}: {
  account: AccountRow;
  branches?: Array<{ id: string; name: string; address: string | null; active: boolean }>;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Profile"
        hint="Branches, contact and commercial terms"
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setModalOpen(true)}
          >
            Edit profile…
          </Button>
        }
      />

      <dl className="divide-y divide-ink-200">
        <DefinitionRow term="Owner WhatsApp">
          {account.ownerPhoneE164 ?? '—'}
        </DefinitionRow>
        <DefinitionRow term="Timezone">
          {account.timezone}
        </DefinitionRow>
        <DefinitionRow term="Discount">
          0%
        </DefinitionRow>
      </dl>

      <div className="border-t border-ink-200 px-5 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Branches</p>
        <ul className="mt-1.5 space-y-1">
          {branches.map((branch) => (
            <li key={branch.id} className="text-sm text-ink-700">
              {branch.name}
              {!branch.active && (
                <span className="ml-1.5 text-xs text-ink-400">(inactive)</span>
              )}
              {branch.address && (
                <span className="ml-1.5 text-xs text-ink-400">{branch.address}</span>
              )}
            </li>
          ))}
          {branches.length === 0 && (
            <li className="text-sm text-ink-400">None</li>
          )}
        </ul>
      </div>

      <ConfirmModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Edit hospital profile"
      >
        <form action={updateProfileAction} className="space-y-4">
          <input type="hidden" name="hospitalId" value={account.hospitalId} />
          <Field label="Hospital name">
            <Input name="name" defaultValue={account.name} className="py-2 text-sm" />
          </Field>
          <Field label="Owner WhatsApp" hint="Where the monthly summary goes">
            <Input
              name="ownerPhoneE164"
              defaultValue={account.ownerPhoneE164 ?? ''}
              placeholder="+919876543210"
              className="py-2 text-sm"
            />
          </Field>
          <Field label="Timezone">
            <Input name="timezone" defaultValue={account.timezone} className="py-2 text-sm" />
          </Field>
          <Field label="Discount %" hint="Founding-customer or negotiated rate">
            <Input
              name="discountPercent"
              type="number"
              min={0}
              max={100}
              defaultValue={0}
              className="py-2 text-sm"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
            <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save profile
            </Button>
          </div>
        </form>
      </ConfirmModal>
    </Card>
  );
}
