'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Input, Alert } from '@/components/ui';
import { maskPhone } from '@/lib/domain/booking-trace';
import type { NoticeSelectionResult } from '@/lib/domain/notice-selection';

export interface MandatoryItem {
  phoneE164: string;
  patientId?: string | null;
  patientName?: string;
}

export type RecipientMode = 'both' | 'recent_only' | 'mandatory_only';

interface NoticeRecipientsStepProps {
  hospitalId: string;
  closureDate: string;
  closureEndDate?: string;
  mode: RecipientMode;
  onModeChange: (mode: RecipientMode) => void;
  mandatoryList: MandatoryItem[];
  onMandatoryChange: (list: MandatoryItem[]) => void;
  onBack: () => void;
  onNext: () => void;
}

interface PatientSearchResult {
  id: string;
  name: string;
  phoneE164: string;
  whatsappOptInAt: string | null;
}

export function NoticeRecipientsStep({
  hospitalId,
  closureDate,
  closureEndDate,
  mode,
  onModeChange,
  mandatoryList,
  onMandatoryChange,
  onBack,
  onNext,
}: NoticeRecipientsStepProps) {
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PatientSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Manual input state
  const [manualPhone, setManualPhone] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // Live preview stats
  const [previewStats, setPreviewStats] = useState<NoticeSelectionResult | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleNextClick = async () => {
    setIsSubmitting(true);
    try {
      await onNext();
    } finally {
      setIsSubmitting(false);
    }
  };

  // Fetch live preview calculation from backend
  const fetchPreview = useCallback(async () => {
    setIsLoadingPreview(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/hospitals/${hospitalId}/whatsapp-notices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          closureDate: closureDate || undefined,
          closureEndDate: closureEndDate || undefined,
          mandatoryRecipients: mode === 'recent_only' ? [] : mandatoryList,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to calculate recipient preview');
      }

      const result: NoticeSelectionResult = await res.json();
      setPreviewStats(result);
    } catch (err: any) {
      setPreviewError(err.message || 'Error calculating preview');
    } finally {
      setIsLoadingPreview(false);
    }
  }, [hospitalId, closureDate, closureEndDate, mode, mandatoryList]);

  // Update preview on changes
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchPreview();
    }, 300);
    return () => clearTimeout(timer);
  }, [fetchPreview]);

  // Patient search handler
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(
          `/api/hospitals/${hospitalId}/patients/search?q=${encodeURIComponent(searchQuery.trim())}`,
        );
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.patients || data.results || []);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, hospitalId]);

  // Add patient from search
  const handleAddPatient = (patient: PatientSearchResult) => {
    const alreadyExists = mandatoryList.some(
      (m) => m.phoneE164 === patient.phoneE164 || (m.patientId && m.patientId === patient.id),
    );

    if (alreadyExists) return;

    onMandatoryChange([
      ...mandatoryList,
      {
        patientId: patient.id,
        phoneE164: patient.phoneE164,
        patientName: patient.name,
      },
    ]);
    setSearchQuery('');
    setSearchResults([]);
  };

  // Add manual phone
  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);

    const raw = manualPhone.trim();
    if (!raw) return;

    // Normalize phone format
    const cleaned = raw.replace(/[^\d+]/g, '');
    let normalized = cleaned;
    if (normalized.startsWith('+91') && normalized.length === 13) {
      // valid
    } else if (normalized.startsWith('91') && normalized.length === 12) {
      normalized = `+${normalized}`;
    } else if (normalized.length === 10 && /^[6-9]/.test(normalized)) {
      normalized = `+91${normalized}`;
    } else if (!normalized.startsWith('+') || normalized.length < 11) {
      setManualError('Enter a valid mobile number with country code (e.g. +91 98200 12345)');
      return;
    }

    const alreadyExists = mandatoryList.some((m) => m.phoneE164 === normalized);
    if (alreadyExists) {
      setManualError('This phone number has already been added to mandatory recipients');
      return;
    }

    onMandatoryChange([
      ...mandatoryList,
      {
        phoneE164: normalized,
        patientName: manualName.trim() || undefined,
        patientId: null,
      },
    ]);

    setManualPhone('');
    setManualName('');
  };

  // Remove mandatory recipient
  const handleRemoveMandatory = (phoneE164: string) => {
    onMandatoryChange(mandatoryList.filter((m) => m.phoneE164 !== phoneE164));
  };

  const hasTooManyMandatory = mandatoryList.length > 250;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-ink-900">Step 3 — Select Recipients</h2>
        <p className="mt-1 text-sm text-ink-600">
          The campaign will automatically select recently active eligible patients up to 250 recipients.
          You can mark specific patients or phone numbers as mandatory; they will take priority and displace less-recent patients.
        </p>
      </div>

      {/* Recipient Strategy Mode */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-ink-900">Recipient Strategy</h3>
        <p className="text-xs text-ink-500 mt-0.5">Choose how the audience is composed:</p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label
            className={`flex flex-col p-4 rounded-lg border cursor-pointer transition-colors ${
              mode === 'both'
                ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600'
                : 'border-ink-200 hover:bg-ink-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="recipientMode"
                value="both"
                checked={mode === 'both'}
                onChange={() => onModeChange('both')}
                className="text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm font-semibold text-ink-900">Both (Recommended)</span>
            </div>
            <span className="mt-1 text-xs text-ink-600">
              Auto-select top recent patients, plus prioritize any mandatory numbers you add.
            </span>
          </label>

          <label
            className={`flex flex-col p-4 rounded-lg border cursor-pointer transition-colors ${
              mode === 'recent_only'
                ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600'
                : 'border-ink-200 hover:bg-ink-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="recipientMode"
                value="recent_only"
                checked={mode === 'recent_only'}
                onChange={() => onModeChange('recent_only')}
                className="text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm font-semibold text-ink-900">Recently Active Only</span>
            </div>
            <span className="mt-1 text-xs text-ink-600">
              Only send to the most recently active eligible patients up to campaign capacity.
            </span>
          </label>

          <label
            className={`flex flex-col p-4 rounded-lg border cursor-pointer transition-colors ${
              mode === 'mandatory_only'
                ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600'
                : 'border-ink-200 hover:bg-ink-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="recipientMode"
                value="mandatory_only"
                checked={mode === 'mandatory_only'}
                onChange={() => onModeChange('mandatory_only')}
                className="text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm font-semibold text-ink-900">Specific List Only</span>
            </div>
            <span className="mt-1 text-xs text-ink-600">
              Only send to the specific mandatory recipients you select below.
            </span>
          </label>
        </div>
      </Card>

      {/* Live Capacity & Audience Overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Campaign Cap</span>
          <p className="mt-1 text-2xl font-bold text-ink-900">250</p>
          <span className="text-xs text-ink-500">Max allowed per campaign</span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Account Available</span>
          <p className="mt-1 text-2xl font-bold text-brand-700">
            {previewStats?.accountAvailableCapacity ?? '...'}
          </p>
          <span className="text-xs text-ink-500">Rolling 24h WhatsApp capacity</span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Projected Selection</span>
          <p className="mt-1 text-2xl font-bold text-ink-900">
            {isLoadingPreview ? '...' : (previewStats?.totalSelectedRecipients ?? 0)}
          </p>
          <span className="text-xs text-ink-500">
            {previewStats ? `of ${previewStats.totalEligibleRecipients} eligible` : 'Calculating...'}
          </span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Mandatory Priority</span>
          <p className="mt-1 text-2xl font-bold text-ink-900">{mandatoryList.length}</p>
          <span className="text-xs text-ink-500">
            {previewStats?.displacedCount ? `${previewStats.displacedCount} displaced` : '0 displaced'}
          </span>
        </Card>
      </div>

      {/* Ineligible Mandatory Warnings */}
      {previewStats && previewStats.ineligibleRecipients.length > 0 && (
        <Alert tone="warn">
          <div className="space-y-1">
            <p className="font-semibold text-amber-900">
              {previewStats.ineligibleRecipients.length} mandatory recipient(s) cannot receive notices:
            </p>
            <ul className="list-disc list-inside text-xs text-amber-800 space-y-0.5">
              {previewStats.ineligibleRecipients.map((item, idx) => (
                <li key={idx}>
                  <span className="font-medium">{item.patientName || maskPhone(item.phoneE164)}</span>:{' '}
                  {item.reason === 'no_consent'
                    ? 'No WhatsApp opt-in consent recorded'
                    : item.reason === 'opted_out'
                    ? 'Patient previously opted out of WhatsApp messages'
                    : 'Invalid phone number format'}
                </li>
              ))}
            </ul>
            <p className="text-xs text-amber-800 pt-1">
              WhatsApp messaging policy requires valid recipient opt-in. Ineligible numbers will not receive messages.
            </p>
          </div>
        </Alert>
      )}

      {hasTooManyMandatory && (
        <Alert tone="error">
          <p className="font-semibold text-rose-900">Maximum Mandatory Limit Exceeded</p>
          <p className="text-xs text-rose-800 mt-0.5">
            You have selected {mandatoryList.length} mandatory recipients. The maximum campaign cap is 250.
            Please remove some mandatory numbers before continuing.
          </p>
        </Alert>
      )}

      {previewError && (
        <Alert tone="error">
          <p className="text-sm font-semibold">{previewError}</p>
        </Alert>
      )}

      {/* Mandatory Recipient Selection Section (visible when mode != 'recent_only') */}
      {mode !== 'recent_only' && (
        <Card className="p-5 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-ink-900">Add Mandatory Recipients</h3>
            <p className="text-xs text-ink-500 mt-0.5">
              Mandatory recipients are guaranteed a slot and displace less-recently active recipients.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Search Patients */}
            <div className="space-y-3">
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Search Registered Patients
              </label>
              <div className="relative">
                <Input
                  type="text"
                  placeholder="Search by patient name (similar names matched) or phone..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {isSearching && (
                  <span className="absolute right-3 top-2.5 text-xs text-ink-400">Searching...</span>
                )}
              </div>

              {/* Search dropdown results */}
              {searchResults.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-200 bg-white shadow-sm divide-y divide-ink-100">
                  {searchResults.map((patient) => {
                    const isAdded = mandatoryList.some(
                      (m) => m.phoneE164 === patient.phoneE164 || m.patientId === patient.id,
                    );
                    return (
                      <div
                        key={patient.id}
                        className="flex items-center justify-between p-2.5 hover:bg-ink-50 transition-colors"
                      >
                        <div className="min-w-0 pr-2">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-ink-900 truncate">{patient.name}</p>
                            {patient.whatsappOptInAt ? (
                              <span className="inline-flex items-center px-1.5 py-0.2 text-[10px] font-medium rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Consented
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-1.5 py-0.2 text-[10px] font-medium rounded bg-amber-50 text-amber-700 border border-amber-200">
                                No Opt-In
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-ink-500">{maskPhone(patient.phoneE164)}</p>
                        </div>
                        <Button
                          size="sm"
                          variant={isAdded ? 'ghost' : 'secondary'}
                          disabled={isAdded}
                          onClick={() => handleAddPatient(patient)}
                        >
                          {isAdded ? 'Added' : '+ Add'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                <p className="text-xs text-ink-500 italic">No patients found matching &quot;{searchQuery}&quot;</p>
              )}
            </div>

            {/* Manual Phone Entry */}
            <div className="space-y-3">
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Enter Phone Number Manually
              </label>
              <form onSubmit={handleAddManual} className="space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    type="tel"
                    placeholder="+91 98200 12345"
                    value={manualPhone}
                    onChange={(e) => setManualPhone(e.target.value)}
                  />
                  <Input
                    type="text"
                    placeholder="Name (Optional)"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                  />
                </div>
                {manualError && <p className="text-xs text-rose-600 font-medium">{manualError}</p>}
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="secondary" disabled={!manualPhone.trim()}>
                    + Add Number
                  </Button>
                </div>
              </form>
              <p className="text-[11px] text-ink-400">
                Note: WhatsApp policy requires opt-in consent before sending template notices.
              </p>
            </div>
          </div>

          {/* List of currently added mandatory numbers */}
          <div className="pt-4 border-t border-ink-100">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-700">
                Selected Mandatory Recipients ({mandatoryList.length})
              </h4>
              {mandatoryList.length > 0 && (
                <button
                  type="button"
                  onClick={() => onMandatoryChange([])}
                  className="text-xs text-rose-600 hover:text-rose-800 font-medium"
                >
                  Clear All
                </button>
              )}
            </div>

            {mandatoryList.length === 0 ? (
              <p className="text-xs text-ink-400 italic py-2">
                No mandatory recipients selected. In &quot;Both&quot; mode, the top 250 most recently active patients will be selected automatically.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-ink-200 divide-y divide-ink-100">
                {mandatoryList.map((item) => (
                  <div
                    key={item.phoneE164}
                    className="flex items-center justify-between px-3 py-2 text-sm hover:bg-ink-50/50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="inline-flex size-2 rounded-full bg-brand-600 shrink-0" />
                      <span className="font-medium text-ink-900 truncate">
                        {item.patientName || 'External Recipient'}
                      </span>
                      <span className="text-xs text-ink-500 font-mono">
                        {maskPhone(item.phoneE164)}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRemoveMandatory(item.phoneE164)}
                      className="text-ink-400 hover:text-rose-600 h-7 px-2"
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-ink-200">
        <Button variant="secondary" onClick={onBack}>
          ← Back to Notice Details
        </Button>
        <Button
          variant="primary"
          onClick={handleNextClick}
          isLoading={isSubmitting}
          disabled={
            hasTooManyMandatory ||
            (mode === 'mandatory_only' && mandatoryList.length === 0) ||
            isSubmitting
          }
          className="min-w-36 font-semibold"
        >
          Preview Final Recipients →
        </Button>
      </div>
    </div>
  );
}
