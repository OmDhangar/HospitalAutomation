'use client';

import { useState } from 'react';
import { Button, cn } from '@/components/ui';

export interface RoundNoteEditorProps {
  notes: string;
  onChangeNotes: (notes: string) => void;
  onSaveDraft: () => Promise<void>;
  onOpenSigningModal: () => void;
  isDraftPending?: boolean;
  lastSavedAt?: Date | null;
  totalOrdersToAuthorize: number;
  className?: string;
}

const TEMPLATE_SNIPPETS = [
  {
    label: 'SOAP Note',
    text: 'S: Patient comfortable, no new complaints.\nO: Vitals stable, chest clear, abdomen soft.\nA: Improving clinical status.\nP: Continue current medication regimen, observe.',
  },
  {
    label: 'Stable / Afebrile',
    text: 'Patient afebrile and hemodynamically stable. Tolerating oral intake.',
  },
  {
    label: 'Post-Op Day 1',
    text: 'POD-1: Surgical site clean and dry. Pain managed adequately on PRN analgesics. Vitals stable.',
  },
  {
    label: 'Step-Down Plan',
    text: 'Clinical improvement noted. Step down to oral antibiotics, encourage mobilization, plan for discharge review.',
  },
];

export function RoundNoteEditor({
  notes,
  onChangeNotes,
  onSaveDraft,
  onOpenSigningModal,
  isDraftPending = false,
  lastSavedAt,
  totalOrdersToAuthorize,
  className,
}: RoundNoteEditorProps) {
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  const handleSnippetInsert = (snippetText: string) => {
    if (!notes.trim()) {
      onChangeNotes(snippetText);
    } else {
      onChangeNotes(`${notes}\n\n${snippetText}`);
    }
  };

  const handleDraftClick = async () => {
    setSaveSuccessMsg(null);
    await onSaveDraft();
    setSaveSuccessMsg('Draft saved successfully');
    setTimeout(() => setSaveSuccessMsg(null), 3000);
  };

  const formattedSavedAt = lastSavedAt
    ? new Date(lastSavedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className={cn('space-y-3 rounded-xl border border-ink-200 bg-white p-4 shadow-xs', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Clinical Round Notes & Assessment
          </h3>
          <p className="text-xs text-ink-500">
            Document clinical observations, daily progress, and rationale for therapeutic changes.
          </p>
        </div>

        {/* Quick template snippets */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] font-semibold text-ink-400 uppercase tracking-wider mr-1">
            Insert:
          </span>
          {TEMPLATE_SNIPPETS.map((snippet) => (
            <button
              key={snippet.label}
              type="button"
              onClick={() => handleSnippetInsert(snippet.text)}
              className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-xs text-ink-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800"
            >
              + {snippet.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <textarea
          rows={5}
          value={notes}
          onChange={(e) => onChangeNotes(e.target.value)}
          placeholder="Enter daily progress note, subjective complaints, physical exam findings, and management plan..."
          className="w-full rounded-lg border border-ink-300 bg-white p-3 text-xs leading-relaxed text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-500 font-sans"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-3">
        <div className="flex items-center gap-2 text-xs text-ink-500">
          {isDraftPending ? (
            <span className="inline-flex items-center gap-1.5 text-brand-600">
              <span className="size-2 rounded-full bg-brand-500 animate-pulse" />
              Saving draft...
            </span>
          ) : saveSuccessMsg ? (
            <span className="font-medium text-emerald-600">✓ {saveSuccessMsg}</span>
          ) : formattedSavedAt ? (
            <span>Draft saved at {formattedSavedAt}</span>
          ) : (
            <span>Draft not yet saved</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleDraftClick}
            isLoading={isDraftPending}
          >
            Save Draft
          </Button>

          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onOpenSigningModal}
            className="bg-brand-600 font-semibold hover:bg-brand-700"
          >
            <span>Review & Authorize Orders</span>
            {totalOrdersToAuthorize > 0 && (
              <span className="ml-1.5 rounded-full bg-brand-800 px-1.5 py-0.2 text-[10px] font-bold text-white">
                {totalOrdersToAuthorize}
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
