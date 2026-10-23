'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui';
import { NoticeTypeStep, type NoticeType } from './notice-type-step';
import { NoticeDetailsStep, type NoticeDetailsData } from './notice-details-step';
import {
  NoticeRecipientsStep,
  type MandatoryItem,
  type RecipientMode,
} from './notice-recipients-step';
import { NoticePreviewStep } from './notice-preview-step';
import type { NoticeSelectionResult } from '@/lib/domain/notice-selection';

interface NoticeWizardProps {
  hospitalId: string;
  hospitalName: string;
  defaultPhone?: string;
}

export function NoticeWizard({ hospitalId, hospitalName, defaultPhone }: NoticeWizardProps) {
  const router = useRouter();

  // Wizard Step
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: Type
  const [noticeType, setNoticeType] = useState<NoticeType>('hospital_closure');

  // Tomorrow's date as default
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDateStr = tomorrow.toISOString().split('T')[0];

  // Step 2: Details
  const [details, setDetails] = useState<NoticeDetailsData>({
    title: `Hospital Closure Notice - ${tomorrow.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
    closureDate: defaultDateStr,
    closureDuration: 'Full day',
    reason: 'unforeseen maintenance and repairs',
    rescheduleInstructions: 'Appointments will be rescheduled for the next available clinic day.',
    contactPhone: defaultPhone || '+91 ',
    templateCode: 'opd_hospital_closure_notice',
  });

  // Campaign Draft ID
  const [campaignId, setCampaignId] = useState<string | null>(null);

  // Step 3: Recipients
  const [recipientMode, setRecipientMode] = useState<RecipientMode>('both');
  const [mandatoryList, setMandatoryList] = useState<MandatoryItem[]>([]);

  // Step 4: Preview & Confirmation
  const [previewData, setPreviewData] = useState<NoticeSelectionResult | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Step Navigation Handlers
  const handleDetailsChange = (fields: Partial<NoticeDetailsData>) => {
    setDetails((prev) => ({ ...prev, ...fields }));
  };

  const handleStep2Next = async () => {
    setErrorMessage(null);
    try {
      // Create or update draft campaign
      const res = await fetch(`/api/hospitals/${hospitalId}/whatsapp-notices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noticeType,
          title: details.title,
          closureDate: details.closureDate,
          closureDuration: details.closureDuration,
          reason: details.reason,
          rescheduleInstructions: details.rescheduleInstructions,
          contactPhone: details.contactPhone,
          templateCode: details.templateCode,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save notice draft');
      }

      const data = await res.json();
      setCampaignId(data.id);
      setCurrentStep(3);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error saving notice draft');
    }
  };

  const handleStep3Next = async () => {
    if (!campaignId) return;
    setErrorMessage(null);
    setIsLoadingPreview(true);
    setCurrentStep(4);

    try {
      // 1. Save mandatory list
      const saveRes = await fetch(`/api/whatsapp-notices/${campaignId}/recipients/mandatory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: recipientMode === 'recent_only' ? [] : mandatoryList,
        }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save mandatory recipients');
      }

      // 2. Fetch full preview
      const prevRes = await fetch(`/api/hospitals/${hospitalId}/whatsapp-notices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId,
          closureDate: details.closureDate,
          mandatoryRecipients: recipientMode === 'recent_only' ? [] : mandatoryList,
        }),
      });

      if (!prevRes.ok) {
        const err = await prevRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to calculate recipient preview');
      }

      const prevResult: NoticeSelectionResult = await prevRes.json();
      setPreviewData(prevResult);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error generating preview');
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleConfirmAndSend = async () => {
    if (!campaignId) return;
    setIsConfirming(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/whatsapp-notices/${campaignId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to confirm and dispatch campaign');
      }

      // Successfully dispatched - redirect to campaign tracker
      router.push(`/whatsapp-notices/${campaignId}`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error dispatching campaign');
      setIsConfirming(false);
    }
  };

  // Step indicator steps
  const steps = [
    { num: 1, label: 'Notice Type' },
    { num: 2, label: 'Notice Details' },
    { num: 3, label: 'Select Recipients' },
    { num: 4, label: 'Review & Confirm' },
  ];

  return (
    <div className="space-y-8 max-w-5xl mx-auto py-4">
      {/* Stepper Progress Header */}
      <div className="border-b border-ink-200 pb-5">
        <h1 className="text-2xl font-bold text-ink-900">Create WhatsApp Notice</h1>
        <p className="mt-1 text-xs text-ink-600">
          Guided 4-step wizard to create, preview, and dispatch approved hospital notices.
        </p>

        {/* Stepper Breadcrumb */}
        <div className="mt-6 flex items-center justify-between">
          {steps.map((s, idx) => (
            <React.Fragment key={s.num}>
              <div className="flex items-center gap-2">
                <span
                  className={`flex size-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    currentStep === s.num
                      ? 'bg-brand-600 text-white shadow-xs'
                      : currentStep > s.num
                      ? 'bg-emerald-600 text-white'
                      : 'bg-ink-100 text-ink-500'
                  }`}
                >
                  {currentStep > s.num ? '✓' : s.num}
                </span>
                <span
                  className={`text-xs font-medium hidden sm:inline ${
                    currentStep === s.num ? 'text-ink-900 font-semibold' : 'text-ink-500'
                  }`}
                >
                  {s.label}
                </span>
              </div>
              {idx < steps.length - 1 && (
                <div
                  className={`h-0.5 flex-1 mx-2 sm:mx-4 transition-colors ${
                    currentStep > s.num ? 'bg-emerald-600' : 'bg-ink-200'
                  }`}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Global Error Banner */}
      {errorMessage && (
        <Alert tone="error">
          <p className="font-semibold text-xs">{errorMessage}</p>
        </Alert>
      )}

      {/* Wizard Step Body */}
      {currentStep === 1 && (
        <NoticeTypeStep
          selectedType={noticeType}
          onSelectType={setNoticeType}
          onNext={() => setCurrentStep(2)}
        />
      )}

      {currentStep === 2 && (
        <NoticeDetailsStep
          hospitalName={hospitalName}
          data={details}
          onChange={handleDetailsChange}
          onBack={() => setCurrentStep(1)}
          onNext={handleStep2Next}
        />
      )}

      {currentStep === 3 && (
        <NoticeRecipientsStep
          hospitalId={hospitalId}
          closureDate={details.closureDate}
          mode={recipientMode}
          onModeChange={setRecipientMode}
          mandatoryList={mandatoryList}
          onMandatoryChange={setMandatoryList}
          onBack={() => setCurrentStep(2)}
          onNext={handleStep3Next}
        />
      )}

      {currentStep === 4 && (
        <NoticePreviewStep
          hospitalName={hospitalName}
          closureDate={details.closureDate}
          previewData={previewData}
          isLoading={isLoadingPreview}
          isConfirming={isConfirming}
          onConfirm={handleConfirmAndSend}
          onBack={() => setCurrentStep(3)}
        />
      )}
    </div>
  );
}
