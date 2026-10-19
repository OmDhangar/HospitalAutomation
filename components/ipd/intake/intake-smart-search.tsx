'use client';

import { useEffect, useState, useTransition } from 'react';
import { AlertCircleIcon, CheckIcon, SearchIcon, XIcon } from '@/components/icons';
import { Button, cn } from '@/components/ui';
import { detectSearchType, type SearchMatchType, type SmartSearchResult } from '@/lib/domain/patient-search';
import { registerUnidentifiedAction, searchPatientsSmartAction } from '@/app/(app)/ipd/actions';

export interface IntakeSmartSearchProps {
  onSelectPatient: (patient: SmartSearchResult | {
    id: string;
    name: string;
    phoneE164: string;
    age: number | null;
    gender: string | null;
    address: string | null;
    mrn: string | null;
    qid: string | null;
  }) => void;
  selectedPatientId?: string | null;
}

export function IntakeSmartSearch({ onSelectPatient, selectedPatientId }: IntakeSmartSearchProps) {
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchMatchType>('phone');
  const [results, setResults] = useState<SmartSearchResult[]>([]);
  const [isSearching, startSearch] = useTransition();
  const [hasSearched, setHasSearched] = useState(false);
  const [showUnidentifiedModal, setShowUnidentifiedModal] = useState(false);

  // Unidentified modal state
  const [tempGender, setTempGender] = useState<'male' | 'female' | 'other'>('male');
  const [tempAge, setTempAge] = useState<number | ''>(40);
  const [tempNote, setTempNote] = useState('');
  const [isRegistering, startRegistering] = useTransition();

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    const type = detectSearchType(query);
    setSearchType(type);

    const timer = setTimeout(() => {
      startSearch(async () => {
        const res = await searchPatientsSmartAction(query);
        if (res.ok && res.data) {
          setResults(res.data);
          setHasSearched(true);
        }
      });
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const handleRegisterUnidentified = () => {
    startRegistering(async () => {
      const res = await registerUnidentifiedAction({
        gender: tempGender,
        approxAge: typeof tempAge === 'number' ? tempAge : null,
        descriptiveNote: tempNote.trim() || null,
      });

      if (res.ok && res.data) {
        onSelectPatient({
          id: res.data.patientId,
          name: res.data.tempName,
          phoneE164: '+910000000000',
          age: typeof tempAge === 'number' ? tempAge : null,
          gender: tempGender,
          address: 'Casualty / Emergency Walk-in',
          mrn: res.data.mrn,
          qid: null,
        });
        setShowUnidentifiedModal(false);
      }
    });
  };

  return (
    <div className="space-y-2.5">
      {/* Search Input Box */}
      <div className="relative">
        <div className="relative flex items-center">
          <div className="pointer-events-none absolute left-3 flex items-center text-ink-400">
            <SearchIcon className="size-4" />
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Mobile, Patient Name, UHID/QID, or MRN..."
            className="w-full rounded-lg border border-ink-300 bg-white py-2 pl-9 pr-24 text-sm text-ink-900 shadow-xs placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            aria-label="Patient smart search"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setHasSearched(false);
              }}
              className="absolute right-18 text-ink-400 hover:text-ink-600"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}

          {/* Search Type Badge */}
          <div className="absolute right-2.5">
            <span className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              searchType === 'phone' && 'bg-blue-50 text-blue-700 border border-blue-200',
              searchType === 'qid' && 'bg-purple-50 text-purple-700 border border-purple-200',
              searchType === 'mrn' && 'bg-teal-50 text-teal-700 border border-teal-200',
              searchType === 'name' && 'bg-amber-50 text-amber-700 border border-amber-200',
            )}>
              {searchType}
            </span>
          </div>
        </div>

        {/* Live Results Dropdown - In-flow and fully visible */}
        {query.trim().length > 0 && (
          <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-ink-200 bg-ink-50/40 p-2 shadow-2xs space-y-1.5">
            {isSearching && (
              <div className="p-3 text-center text-xs text-ink-500 font-medium animate-pulse">
                Searching directory for "{query}"...
              </div>
            )}

            {!isSearching && results.length === 0 && hasSearched && (
              <div className="p-3 text-center">
                <p className="text-xs font-semibold text-ink-800">No registered patient found matching "{query}"</p>
                <p className="text-[11px] text-ink-500 mt-0.5">Use the "Enter New Walk-in Patient" tab above to register.</p>
              </div>
            )}

            {!isSearching && results.map((patient) => {
              const isSelected = selectedPatientId === patient.id;
              const hasActiveStay = Boolean(patient.activeStay);

              return (
                <button
                  key={patient.id}
                  type="button"
                  onClick={() => {
                    onSelectPatient(patient);
                    setQuery('');
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg p-2.5 text-left transition-all border',
                    isSelected
                      ? 'bg-brand-50 text-brand-900 border-brand-300 ring-1 ring-brand-400'
                      : 'bg-white hover:bg-brand-50/60 hover:border-brand-300 text-ink-900 border-ink-200/80 shadow-2xs',
                  )}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold text-sm text-ink-900">{patient.name}</span>
                      <span className="text-xs text-ink-600 font-medium">
                        {[patient.age ? `${patient.age}y` : null, patient.gender?.[0]?.toUpperCase()]
                          .filter(Boolean)
                          .join(' ')}
                      </span>
                      {patient.qid ? (
                        <span className="rounded bg-purple-50 px-1.5 py-0.2 text-[10px] font-mono font-semibold text-purple-700 border border-purple-200">
                          {patient.qid}
                        </span>
                      ) : null}
                      {patient.mrn ? (
                        <span className="rounded bg-ink-100 px-1.5 py-0.2 text-[10px] font-mono font-semibold text-ink-700">
                          MRN: {patient.mrn}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-600">
                      <span>📞 {patient.phoneE164}</span>
                      {patient.address && <span>📍 {patient.address}</span>}
                    </div>

                    {/* Active Stay Duplicate Warning */}
                    {hasActiveStay && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                        <AlertCircleIcon className="size-3 text-amber-600" />
                        <span>
                          Warning: Active IPD stay in {patient.activeStay?.wardName ?? 'Ward'}, Bed {patient.activeStay?.bedLabel ?? '?'}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 pl-3">
                    <span className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white shadow-2xs hover:bg-brand-700">
                      Select Patient →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick Action: Register Unidentified Patient */}
      <div className="flex items-center justify-between text-xs text-ink-600">
        <span>No phone or identity documents available in casualty?</span>
        <button
          type="button"
          onClick={() => setShowUnidentifiedModal(true)}
          className="font-semibold text-rose-600 hover:text-rose-700 hover:underline"
        >
          + Register Unidentified Patient (Temp ID)
        </button>
      </div>

      {/* Unidentified Patient Modal */}
      {showUnidentifiedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-ink-950/10">
            <div className="flex items-start justify-between border-b border-ink-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-ink-900">
                  Register Unidentified Patient
                </h3>
                <p className="text-xs text-ink-500">
                  Assigns a hospital-local temporary MRN without creating a global QID.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowUnidentifiedModal(false)}
                className="rounded-lg p-1 text-ink-400 hover:bg-ink-100"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold uppercase text-ink-600">Gender</label>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {(['male', 'female', 'other'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setTempGender(g)}
                      className={cn(
                        'rounded-lg border p-2 text-xs font-medium capitalize',
                        tempGender === g
                          ? 'border-brand-600 bg-brand-50 text-brand-900 font-semibold'
                          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                      )}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-ink-600">Approximate Age</label>
                <input
                  type="number"
                  min="0"
                  max="120"
                  value={tempAge}
                  onChange={(e) => setTempAge(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                  placeholder="e.g. 40"
                  className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-ink-600">
                  Casualty / Triage Descriptive Note
                </label>
                <textarea
                  rows={2}
                  value={tempNote}
                  onChange={(e) => setTempNote(e.target.value)}
                  placeholder="e.g. Brought unconscious by 108 ambulance from highway accident; red shirt"
                  className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400"
                />
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-100 pt-4">
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setShowUnidentifiedModal(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={handleRegisterUnidentified}
                isLoading={isRegistering}
              >
                Generate Temp MRN & Select
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
