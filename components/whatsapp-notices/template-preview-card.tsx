'use client';

import React, { useState } from 'react';
import { Card } from '@/components/ui';
import { formatClosureNoticePeriod } from '@/lib/domain/notice-dates';
import type { Locale } from '@/lib/i18n/patient';

export function TemplatePreviewCard({
  hospitalName,
  closureDate,
  closureEndDate,
  reopenDate,
  reason,
  customMessage,
  contactPhone,
  templateCode,
}: {
  hospitalName: string;
  closureDate?: string;
  closureEndDate?: string;
  reopenDate?: string;
  reason?: string;
  customMessage?: string;
  contactPhone?: string;
  templateCode: string;
}) {
  const [selectedLocale, setSelectedLocale] = useState<Locale>('mr');
  const displayHospital = hospitalName || 'Hospital';
  const displayContact = contactPhone?.trim() || '+91 98200 12345';
  const isGeneral =
    templateCode === 'general_announcement' || templateCode === 'opd_general_announcement';

  const defaultDateStr = closureDate || new Date().toISOString().split('T')[0];
  const { closurePeriodText, reopenDateText } = formatClosureNoticePeriod(
    defaultDateStr,
    closureEndDate,
    selectedLocale,
    reopenDate,
  );

  const displayCustomMessage =
    customMessage?.trim() ||
    (selectedLocale === 'mr'
      ? 'आमच्या रुग्णालयात या रविवारी सकाळी ९ ते दुपारी २ या वेळेत मोफत आरोग्य तपासणी शिबीर आयोजित करण्यात आले आहे. कृपया वेळेची नोंद घ्यावी.'
      : selectedLocale === 'hi'
        ? 'हमारे अस्पताल में इस रविवार सुबह ९ से दोपहर २ बजे तक मुफ्त स्वास्थ्य जांच शिविर आयोजित किया गया है। कृपया समय का संज्ञान लें।'
        : 'Our hospital is organizing a Free Health Checkup Camp this Sunday from 9:00 AM to 2:00 PM. Prior registration is recommended.');

  const currentTime = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  }).format(new Date());

  return (
    <Card className="overflow-hidden border-ink-200 bg-slate-50 shadow-sm">
      {/* WhatsApp Chat Header */}
      <div className="border-b border-ink-200 bg-emerald-800 px-4 py-2.5 text-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-white/20 font-bold text-xs">
            WA
          </div>
          <div>
            <p className="text-xs font-semibold leading-tight">{displayHospital}</p>
            <p className="text-[10px] text-emerald-200 leading-tight">Official WhatsApp Notice</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {(['mr', 'hi', 'en'] as const).map((loc) => (
            <button
              key={loc}
              type="button"
              onClick={() => setSelectedLocale(loc)}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                selectedLocale === loc
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'bg-emerald-900/40 text-emerald-100 hover:bg-emerald-700/50'
              }`}
            >
              {loc === 'mr' ? 'मराठी' : loc === 'hi' ? 'हिंदी' : 'English'}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 sm:p-5">
        {/* Chat message bubble */}
        <div className="max-w-md rounded-2xl rounded-tl-sm bg-white p-3.5 shadow-sm border border-emerald-100 text-ink-900">
          <p className="text-xs font-semibold text-emerald-800 mb-1.5">
            📢 {isGeneral ? 'General Announcement' : 'Official Hospital Notice'}
          </p>

          {isGeneral ? (
            <div className="space-y-2 text-sm leading-relaxed text-ink-900">
              <p className="font-semibold text-ink-900">
                {selectedLocale === 'mr'
                  ? `रुग्णालय सूचना — ${displayHospital}:`
                  : selectedLocale === 'hi'
                    ? `अस्पताल सूचना — ${displayHospital}:`
                    : `Notice from ${displayHospital}:`}
              </p>
              <div className="whitespace-pre-wrap rounded-lg border border-ink-200 bg-slate-50 p-2.5 text-ink-900 font-normal">
                {displayCustomMessage}
              </div>
              <p className="text-xs text-ink-600">
                {selectedLocale === 'mr' ? (
                  <>अधिक माहिती किंवा मदतीसाठी कृपया <strong className="text-ink-900">{displayContact}</strong> वर संपर्क साधा.</>
                ) : selectedLocale === 'hi' ? (
                  <>अधिक जानकारी या सहायता के लिए कृपया <strong className="text-ink-900">{displayContact}</strong> पर संपर्क करें।</>
                ) : (
                  <>For queries or assistance, please contact <strong className="text-ink-900">{displayContact}</strong> on phone.</>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-2.5 text-sm leading-relaxed text-ink-900">
              {selectedLocale === 'mr' ? (
                <>
                  <p className="font-bold text-ink-900">
                    सर्व रुग्ण आणि त्यांच्या नातेवाईकांसाठी महत्त्वाची सूचना:
                  </p>
                  <p>
                    <strong className="text-ink-900">{displayHospital}</strong> हे रुग्णालय{' '}
                    <span className="font-medium text-amber-900 bg-amber-50 px-1 py-0.5 rounded border border-amber-200">{closurePeriodText}</span> पूर्णपणे बंद राहील. या काळात
                    रुग्णालयातील सर्व बाह्यरुग्ण विभाग (OPD) आणि इतर नियमित सेवा बंद राहतील.
                    रुग्णालयाचे कामकाज आणि सर्व सेवा{' '}
                    <span className="font-medium text-emerald-900 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">{reopenDateText}</span> पासून नेहमीप्रमाणे नियमित
                    वेळेत पुन्हा सुरू होतील.
                  </p>
                  <p className="text-xs text-ink-600 border-t border-ink-100 pt-1.5">
                    गैरसोयीबद्दल आम्ही दिलगीर आहोत. अधिक माहितीसाठी कृपया{' '}
                    <strong className="text-ink-900">{displayContact}</strong> वर संपर्क साधा.
                    कृपया सर्व रुग्ण आणि नातेवाईकांनी याची नोंद घ्यावी.
                  </p>
                </>
              ) : selectedLocale === 'hi' ? (
                <>
                  <p className="font-bold text-ink-900">
                    सभी मरीजों और उनके परिजनों के लिए महत्वपूर्ण सूचना:
                  </p>
                  <p>
                    <strong className="text-ink-900">{displayHospital}</strong> अस्पताल{' '}
                    <span className="font-medium text-amber-900 bg-amber-50 px-1 py-0.5 rounded border border-amber-200">{closurePeriodText}</span> पूर्ण रूप से बंद रहेगा। इस
                    दौरान अस्पताल का ओपीडी (OPD) विभाग और अन्य नियमित सेवाएं बंद रहेंगी।
                    अस्पताल का कामकाज और सभी सेवाएं{' '}
                    <span className="font-medium text-emerald-900 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">{reopenDateText}</span> से सामान्य रूप से पुनः
                    शुरू होंगी।
                  </p>
                  <p className="text-xs text-ink-600 border-t border-ink-100 pt-1.5">
                    असुविधा के लिए हमें खेद है। अधिक जानकारी के लिए कृपया{' '}
                    <strong className="text-ink-900">{displayContact}</strong> पर संपर्क करें।
                    सभी मरीज और परिजन कृपया इसका संज्ञान लें।
                  </p>
                </>
              ) : (
                <>
                  <p className="font-bold text-ink-900">
                    Important Notice for all Patients and Relatives:
                  </p>
                  <p>
                    <strong className="text-ink-900">{displayHospital}</strong> will remain
                    completely closed {closurePeriodText}. During this period, all Outpatient
                    Department (OPD) and routine services will be suspended. Hospital operations
                    and regular services will resume normally from{' '}
                    <span className="font-medium text-emerald-900 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">{reopenDateText}</span>.
                  </p>
                  <p className="text-xs text-ink-600 border-t border-ink-100 pt-1.5">
                    We sincerely regret the inconvenience. For any emergency assistance, please
                    contact <strong className="text-ink-900">{displayContact}</strong> on phone.
                    Please take note of this schedule.
                  </p>
                </>
              )}
            </div>
          )}

          <div className="mt-2.5 flex items-center justify-end gap-1 text-[10px] text-ink-400">
            <span>{currentTime}</span>
            <span className="text-emerald-600 font-bold">✓✓</span>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-block size-2 rounded-full ${
                isGeneral ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
            />
            <span>
              Category:{' '}
              <strong className={isGeneral ? 'text-amber-800' : 'text-emerald-800'}>
                {isGeneral ? 'MARKETING' : 'UTILITY'}
              </strong>
              <span className="text-[11px] text-ink-400 ml-1">
                {isGeneral
                  ? '(Custom broadcast / campaign template)'
                  : '(Operational notice)'}
              </span>
            </span>
          </div>
          <span className="text-[11px] text-ink-400">
            Template: <code className="font-mono text-ink-600">{templateCode || 'opd_hospital_closure_update'}</code>
          </span>
        </div>
      </div>
    </Card>
  );
}
