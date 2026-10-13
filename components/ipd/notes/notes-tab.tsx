'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AddClinicalNoteModal } from './add-clinical-note-modal';

export interface ClinicalNoteItem {
  id: string;
  admissionId: string;
  noteType: 'SOAP' | 'NURSING' | 'HANDOVER';
  authorName?: string;
  authorRole?: 'doctor' | 'nurse' | 'other';
  createdAt: Date;
  soapS?: string | null;
  soapO?: string | null;
  soapA?: string | null;
  soapP?: string | null;
  body?: string | null;
}

export interface NotesTabProps {
  admissionId: string;
  notes: ClinicalNoteItem[];
  canAddNote?: boolean;
}

export function NotesTab({
  admissionId,
  notes,
  canAddNote = true,
}: NotesTabProps) {
  const router = useRouter();
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'SOAP' | 'NURSING'>('ALL');
  const [isModalOpen, setIsModalOpen] = useState(false);

  const filteredNotes = notes.filter((n) => {
    if (activeFilter === 'ALL') return true;
    if (activeFilter === 'SOAP') return n.noteType === 'SOAP';
    return n.noteType === 'NURSING' || n.noteType === 'HANDOVER';
  });

  const handleRefresh = () => {
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {/* Header & Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-ink-200 pb-3">
        <div>
          <h2 className="text-sm font-bold text-ink-950">Clinical Progress Notes</h2>
          <p className="text-xs text-ink-500">
            Doctor rounding assessments (SOAP), nursing shift handovers, and clinical evaluations
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <div className="flex items-center gap-1 rounded-lg bg-ink-100 p-0.5">
            <button
              type="button"
              onClick={() => setActiveFilter('ALL')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                activeFilter === 'ALL'
                  ? 'bg-white text-ink-900 shadow-2xs'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              All Notes ({notes.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter('SOAP')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                activeFilter === 'SOAP'
                  ? 'bg-white text-ink-900 shadow-2xs'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              Doctor Rounds
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter('NURSING')}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
                activeFilter === 'NURSING'
                  ? 'bg-white text-ink-900 shadow-2xs'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              Nursing &amp; Handover
            </button>
          </div>

          {canAddNote && (
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="inline-flex items-center rounded-lg bg-brand-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-brand-800 cursor-pointer"
            >
              + Add Clinical Note
            </button>
          )}
        </div>
      </div>

      {/* Notes List */}
      {filteredNotes.length === 0 ? (
        <div className="rounded-xl border border-ink-200/80 bg-white p-8 text-center shadow-2xs">
          <p className="text-xs font-bold text-ink-800">No clinical notes recorded under this category.</p>
          <p className="mt-1 text-xs text-ink-500">
            Click &ldquo;+ Add Clinical Note&rdquo; above to document patient rounds or nursing handover.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredNotes.map((note) => {
            const dateStr = new Date(note.createdAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });

            const isDoctor = note.authorRole === 'doctor' || note.noteType === 'SOAP';

            return (
              <div
                key={note.id}
                className="rounded-xl border border-ink-200/80 bg-white p-4 shadow-2xs transition hover:border-ink-300"
              >
                {/* Note Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-2.5 gap-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                        isDoctor
                          ? 'bg-brand-100 text-brand-800 border border-brand-200'
                          : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                      }`}
                    >
                      {note.noteType === 'SOAP'
                        ? 'Doctor Rounds (SOAP)'
                        : note.noteType === 'HANDOVER'
                          ? 'Shift Handover'
                          : 'Nursing Note'}
                    </span>
                    <span className="text-xs font-bold text-ink-950">
                      {note.authorName || (isDoctor ? 'Consulting Doctor' : 'Staff Nurse')}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-ink-500">{dateStr}</span>
                </div>

                {/* Note Content */}
                <div className="mt-3 text-xs text-ink-800">
                  {note.noteType === 'SOAP' ? (
                    <div className="space-y-2">
                      {note.soapS && (
                        <div className="flex items-start gap-2">
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-800 shrink-0">
                            S
                          </span>
                          <p className="text-xs text-ink-800 leading-relaxed">{note.soapS}</p>
                        </div>
                      )}
                      {note.soapO && (
                        <div className="flex items-start gap-2">
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-800 shrink-0">
                            O
                          </span>
                          <p className="text-xs text-ink-800 leading-relaxed">{note.soapO}</p>
                        </div>
                      )}
                      {note.soapA && (
                        <div className="flex items-start gap-2">
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-800 shrink-0">
                            A
                          </span>
                          <p className="text-xs font-semibold text-ink-900 leading-relaxed">
                            {note.soapA}
                          </p>
                        </div>
                      )}
                      {note.soapP && (
                        <div className="flex items-start gap-2">
                          <span className="rounded bg-purple-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-purple-800 shrink-0">
                            P
                          </span>
                          <p className="text-xs text-ink-800 leading-relaxed">{note.soapP}</p>
                        </div>
                      )}
                      {!note.soapS && !note.soapO && !note.soapA && !note.soapP && note.body && (
                        <p className="text-xs text-ink-800 whitespace-pre-wrap leading-relaxed">
                          {note.body}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-800 whitespace-pre-wrap leading-relaxed">
                      {note.body}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Note Modal */}
      <AddClinicalNoteModal
        admissionId={admissionId}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleRefresh}
      />
    </div>
  );
}
