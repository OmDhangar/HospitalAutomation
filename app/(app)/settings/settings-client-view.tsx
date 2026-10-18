'use client';

import React, { useState, useTransition, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  cn,
} from '@/components/ui';
import {
  BuildingIcon,
  StethoscopeIcon,
  MapPinIcon,
  ClockIcon,
  PillIcon,
  BedIcon,
  LayersIcon,
  ActivityIcon,
  FileTextIcon,
  ShieldIcon,
  PhoneIcon,
  TabletIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  XIcon,
  InfoIcon,
  CheckIcon,
  ZapIcon,
} from '@/components/icons';
import { SaveButton, SaveForm } from '@/components/save-form';
import type { DoctorListItem } from '@/lib/services/hospital';
import type { StaffRole } from '@/lib/services/auth';
import {
  addBranchAction,
  addDoctorAction,
  addStaffAction,
  linkDoctorAccountAction,
  setConsultationFeeAction,
  setDoctorCapacityAction,
  toggleDoctorAction,
  toggleStaffAction,
} from './actions';
import { DoctorScheduleManager } from './scheduling/doctor-schedule-manager';

export interface BranchItem {
  id: string;
  name: string;
  address?: string | null;
}

export interface StaffItem {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId?: string | null;
  branchName?: string | null;
  active: boolean;
  userId: string;
}

export interface SettingsClientViewProps {
  session: {
    hospitalId: string;
    hospitalName: string;
    timezone: string;
    role: string;
    userId: string;
  };
  branches: BranchItem[];
  doctors: DoctorListItem[];
  staff: StaffItem[];
  fees: Record<string, number>;
  limitHit: string | null;
  today: string;
  searchParams: {
    tab?: string;
    error?: string;
    saved?: string;
    id?: string;
    plan?: string;
    message?: string;
    limit?: string;
  };
}

type TabType = 'system' | 'doctors' | 'staff' | 'scheduling';

export function SettingsClientView({
  session,
  branches,
  doctors,
  staff,
  fees,
  limitHit,
  today,
  searchParams,
}: SettingsClientViewProps) {
  const router = useRouter();

  // Determine initial tab from query param or error/saved context
  const initialTab = useMemo<TabType>(() => {
    if (searchParams.tab === 'doctors' || searchParams.tab === 'clinic') return 'doctors';
    if (searchParams.tab === 'staff' || searchParams.tab === 'rbac') return 'staff';
    if (searchParams.tab === 'scheduling' || searchParams.tab === 'schedule') return 'scheduling';
    if (searchParams.tab === 'system') return 'system';

    // Auto-switch to relevant tab if an action redirected here with feedback
    if (
      searchParams.saved === 'fee' ||
      searchParams.saved === 'capacity' ||
      searchParams.saved === 'capacity_above_plan' ||
      searchParams.saved === 'link' ||
      searchParams.error === 'fee' ||
      searchParams.error === 'capacity' ||
      searchParams.error === 'link' ||
      searchParams.limit === 'doctors' ||
      searchParams.limit === 'branches'
    ) {
      return 'doctors';
    }

    if (
      searchParams.error === 'role' ||
      searchParams.error === 'email_in_use' ||
      searchParams.error === 'weak_password' ||
      searchParams.limit === 'staff'
    ) {
      return 'staff';
    }

    return 'system';
  }, [searchParams]);

  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  // Modals & Drawers state
  const [isAddBranchOpen, setIsAddBranchOpen] = useState(false);
  const [isAddDoctorOpen, setIsAddDoctorOpen] = useState(false);
  const [isAddStaffOpen, setIsAddStaffOpen] = useState(false);

  // Doctors accordion expansion (auto-expand doctor that was just saved)
  const [expandedDoctorId, setExpandedDoctorId] = useState<string | null>(
    searchParams.id || (doctors[0]?.id ?? null),
  );

  // Client search & filter states
  const [doctorSearch, setDoctorSearch] = useState('');
  const [doctorBranchFilter, setDoctorBranchFilter] = useState('');
  const [staffSearch, setStaffSearch] = useState('');
  const [staffRoleFilter, setStaffRoleFilter] = useState<'all' | StaffRole>('all');

  // Tab switching with URL query update
  const handleTabChange = (newTab: TabType) => {
    setActiveTab(newTab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', newTab);
    window.history.pushState({}, '', url.toString());
  };

  // Filtered lists
  const filteredDoctors = useMemo(() => {
    return doctors.filter((doc) => {
      const matchSearch =
        !doctorSearch.trim() ||
        doc.name.toLowerCase().includes(doctorSearch.toLowerCase()) ||
        (doc.specialty && doc.specialty.toLowerCase().includes(doctorSearch.toLowerCase()));
      const matchBranch = !doctorBranchFilter || doc.branchId === doctorBranchFilter;
      return matchSearch && matchBranch;
    });
  }, [doctors, doctorSearch, doctorBranchFilter]);

  const filteredStaff = useMemo(() => {
    return staff.filter((member) => {
      const matchSearch =
        !staffSearch.trim() ||
        member.name.toLowerCase().includes(staffSearch.toLowerCase()) ||
        member.email.toLowerCase().includes(staffSearch.toLowerCase()) ||
        (member.branchName && member.branchName.toLowerCase().includes(staffSearch.toLowerCase()));
      const matchRole = staffRoleFilter === 'all' || member.role === staffRoleFilter;
      return matchSearch && matchRole;
    });
  }, [staff, staffSearch, staffRoleFilter]);

  const activeDoctorCount = doctors.filter((d) => d.active).length;
  const activeStaffCount = staff.filter((s) => s.active).length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* 1. Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Hospital Settings</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-ink-500">
            {session.hospitalName} · <span className="font-mono text-ink-600">{session.timezone}</span>
          </p>
        </div>
      </div>

      {/* 2. Global Status & Validation Alerts */}
      <div className="space-y-2.5">
        {searchParams.error === 'name' ? (
          <Alert tone="error">A valid name is required.</Alert>
        ) : null}
        {searchParams.error === 'role' ? (
          <Alert tone="error">Choose a role for the new staff member.</Alert>
        ) : null}
        {searchParams.error === 'email_in_use' ? (
          <Alert tone="error">
            That email already has a login. Each login belongs to one hospital — use a different email address.
          </Alert>
        ) : null}
        {searchParams.error === 'weak_password' ? (
          <Alert tone="error">
            Give a temporary password of at least 10 characters. They will choose their own when they first sign in.
          </Alert>
        ) : null}
        {searchParams.error === 'fee' ? (
          <Alert tone="error">Enter the fee in rupees, like 300.</Alert>
        ) : null}
        {searchParams.error === 'link' ? (
          <Alert tone="error">
            {typeof searchParams.message === 'string' ? searchParams.message : 'Could not link that login.'}
          </Alert>
        ) : null}
        {searchParams.saved === 'link' ? (
          <Alert tone="success">Doctor login account updated successfully.</Alert>
        ) : null}
        {searchParams.error === 'capacity' ? (
          <Alert tone="error">
            {typeof searchParams.message === 'string' ? searchParams.message : 'Could not save the token quota.'}
          </Alert>
        ) : null}
        {searchParams.saved === 'capacity' ? (
          <Alert tone="success">
            Token quota saved. It applies from the next day that has not issued a token; today keeps its numbers.
          </Alert>
        ) : null}
        {searchParams.saved === 'capacity_above_plan' ? (
          <Alert tone="warn">
            Token quota saved. It is above your plan&apos;s{' '}
            {typeof searchParams.plan === 'string' && searchParams.plan ? `${searchParams.plan} ` : ''}patients per day, which is
            allowed during your trial.
          </Alert>
        ) : null}
        {searchParams.saved === 'fee' ? (
          <Alert tone="success">Consultation fee saved. Bills already issued keep their old amount.</Alert>
        ) : null}
        {limitHit ? (
          <Alert tone="warn">
            {limitHit}{' '}
            <Link href="/plans" className="font-semibold underline underline-offset-2">
              See plans
            </Link>
          </Alert>
        ) : null}
      </div>

      {/* 3. Sticky 4-Tab Navigation Architecture */}
      <div className="sticky top-0 z-20 -mx-4 px-4 sm:mx-0 sm:px-0 py-2.5 bg-slate-50/90 backdrop-blur-md border-b border-ink-200">
        <nav className="flex space-x-1 sm:space-x-2 overflow-x-auto pb-0.5 no-scrollbar" aria-label="Settings Tabs">
          <button
            type="button"
            onClick={() => handleTabChange('system')}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer shadow-2xs',
              activeTab === 'system'
                ? 'bg-teal-600 text-white shadow-sm ring-1 ring-teal-700/20'
                : 'bg-white text-ink-600 hover:text-ink-900 hover:bg-ink-100/70 border border-ink-200',
            )}
          >
            <LayersIcon className={cn('size-4', activeTab === 'system' ? 'text-white' : 'text-teal-600')} />
            <span>System & Modules</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('doctors')}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer shadow-2xs',
              activeTab === 'doctors'
                ? 'bg-teal-600 text-white shadow-sm ring-1 ring-teal-700/20'
                : 'bg-white text-ink-600 hover:text-ink-900 hover:bg-ink-100/70 border border-ink-200',
            )}
          >
            <StethoscopeIcon className={cn('size-4', activeTab === 'doctors' ? 'text-white' : 'text-teal-600')} />
            <span>Clinic & Doctors</span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0.2 text-[11px] font-bold',
                activeTab === 'doctors' ? 'bg-teal-700/60 text-white' : 'bg-ink-100 text-ink-600',
              )}
            >
              {doctors.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('staff')}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer shadow-2xs',
              activeTab === 'staff'
                ? 'bg-teal-600 text-white shadow-sm ring-1 ring-teal-700/20'
                : 'bg-white text-ink-600 hover:text-ink-900 hover:bg-ink-100/70 border border-ink-200',
            )}
          >
            <ShieldIcon className={cn('size-4', activeTab === 'staff' ? 'text-white' : 'text-teal-600')} />
            <span>Staff & RBAC</span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0.2 text-[11px] font-bold',
                activeTab === 'staff' ? 'bg-teal-700/60 text-white' : 'bg-ink-100 text-ink-600',
              )}
            >
              {staff.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('scheduling')}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all whitespace-nowrap cursor-pointer shadow-2xs',
              activeTab === 'scheduling'
                ? 'bg-teal-600 text-white shadow-sm ring-1 ring-teal-700/20'
                : 'bg-white text-ink-600 hover:text-ink-900 hover:bg-ink-100/70 border border-ink-200',
            )}
          >
            <ClockIcon className={cn('size-4', activeTab === 'scheduling' ? 'text-white' : 'text-teal-600')} />
            <span>Scheduling Rules</span>
          </button>
        </nav>
      </div>

      {/* 4. Tab 1: System & Modules (3-Column Bento Grid) */}
      {activeTab === 'system' ? (
        <div className="space-y-4 animate-in fade-in-50 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
            {/* Featured Bento Card (col-span-2): WhatsApp Integration */}
            <div className="md:col-span-2 rounded-2xl border border-teal-200/80 bg-gradient-to-br from-teal-50/70 via-white to-emerald-50/40 p-5 sm:p-6 shadow-xs flex flex-col justify-between">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-teal-100 text-teal-900 text-xs font-bold uppercase tracking-wider">
                    <PhoneIcon className="size-3.5 text-teal-700" />
                    <span>Featured Integration</span>
                  </div>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    Active Service
                  </span>
                </div>

                <h3 className="text-xl font-bold text-ink-900">WhatsApp Patient Communications</h3>
                <p className="mt-1.5 text-xs sm:text-sm text-ink-600 leading-relaxed max-w-2xl">
                  Automated booking workflows, live dynamic queue tracking links sent instantly to patients, scheduled follow-up alerts, and digital prescription dispatches straight to WhatsApp.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-4">
                  <div className="rounded-xl bg-white/80 border border-teal-100 p-3 shadow-2xs">
                    <p className="text-xs font-bold text-ink-900">Live Token Tracker</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">Real-time queue positions</p>
                  </div>
                  <div className="rounded-xl bg-white/80 border border-teal-100 p-3 shadow-2xs">
                    <p className="text-xs font-bold text-ink-900">Automated Reminders</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">Zero no-show rate reduction</p>
                  </div>
                  <div className="rounded-xl bg-white/80 border border-teal-100 p-3 shadow-2xs">
                    <p className="text-xs font-bold text-ink-900">Instant Prescriptions</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">Paperless PDF receipts</p>
                  </div>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between">
                <Link href="/settings/whatsapp" className="w-full sm:w-auto">
                  <Button variant="primary" className="w-full sm:w-auto justify-center shadow-xs">
                    Configure WhatsApp Integration
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 1: Medicines Catalogue */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-brand-50 text-brand-700 flex items-center justify-center">
                    <PillIcon className="size-5 text-brand-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    Clinical
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">Medicines Catalogue</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  What doctors can prescribe, dosage frequencies, and standard billing desk tariffs.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/medicines" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Manage medicines
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 2: IPD Wards & Beds */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center">
                    <BedIcon className="size-5 text-indigo-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    Inpatient
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">IPD Wards, Beds & Rates</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  Wards, bed capacity for admissions, daily tariffs, and bedside nursing items.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/ipd" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Set up IPD
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 3: Letterhead & Numbers */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
                    <FileTextIcon className="size-5 text-amber-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    Print & Docs
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">Letterhead & IPD Numbers</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  Hospital registration number, printed letterhead layout, and IPD sequence starting number.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/letterhead" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Set letterhead
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 4: Risk-Class Stock */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-rose-50 text-rose-700 flex items-center justify-center">
                    <ShieldIcon className="size-5 text-rose-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    Pharmacy
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">Risk-Class Stock & Stores</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  Stores, narcotics and high-risk inventory tracking, counting intervals, and dual-signoff policies.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/stock" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Set up stock
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 5: Staff Access */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-violet-50 text-violet-700 flex items-center justify-center">
                    <TabletIcon className="size-5 text-violet-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    Security
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">Staff Access & Device Lock</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  Ward tablets with PIN-based switching, locks on personal devices, and universal signout.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/staff-access" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Manage staff access
                  </Button>
                </Link>
              </div>
            </div>

            {/* Standard Bento Card 6: Modules */}
            <div className="col-span-1 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-brand-300 transition-all">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="size-9 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center">
                    <LayersIcon className="size-5 text-teal-600" />
                  </div>
                  <span className="text-[11px] font-bold text-ink-500 uppercase tracking-wider bg-ink-50 px-2 py-0.5 rounded-md">
                    System
                  </span>
                </div>
                <h4 className="text-base font-bold text-ink-900">Hospital Modules & Features</h4>
                <p className="mt-1 text-xs text-ink-500 line-clamp-2 leading-relaxed">
                  Configure which clinical modules (charts, surgery, pharmacy, dialyzers) are active by ward.
                </p>
              </div>
              <div className="pt-4">
                <Link href="/settings/modules" className="block">
                  <Button variant="secondary" size="sm" className="w-full justify-center">
                    Choose modules
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 5. Tab 2: Clinic & Doctors */}
      {activeTab === 'doctors' ? (
        <div className="space-y-6 animate-in fade-in-50 duration-200">
          {/* A. Branches Section (Full-Width Top Grid) */}
          <Card>
            <div className="p-4 sm:p-5 border-b border-ink-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-gradient-to-r from-ink-50/60 to-white">
              <div>
                <div className="flex items-center gap-2">
                  <BuildingIcon className="size-5 text-brand-600" />
                  <h3 className="text-base font-bold text-ink-900">Hospital Branches</h3>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {branches.length} physical facility {branches.length === 1 ? 'branch' : 'branches'} configured
                </p>
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setIsAddBranchOpen(true)}
                className="shrink-0 gap-1.5 shadow-xs"
              >
                <PlusIcon className="size-4" />
                <span>Add Branch</span>
              </Button>
            </div>

            <div className="p-4 sm:p-5">
              {branches.length === 0 ? (
                <EmptyState
                  title="No branches yet"
                  hint="Add a branch facility before adding doctors or scheduling appointments."
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                  {branches.map((branch) => (
                    <div
                      key={branch.id}
                      className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs hover:border-brand-300 transition-all flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <BuildingIcon className="size-4 text-brand-600 shrink-0" />
                          <h4 className="text-sm font-bold text-ink-900 truncate">{branch.name}</h4>
                        </div>
                        {branch.address ? (
                          <p className="text-xs text-ink-500 mt-1 truncate flex items-center gap-1">
                            <MapPinIcon className="size-3 text-ink-400 shrink-0" />
                            <span>{branch.address}</span>
                          </p>
                        ) : (
                          <p className="text-xs text-ink-400 mt-1 italic">No address provided</p>
                        )}
                      </div>
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                        Active
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* B. Doctors Section (Collapsible Accordion List) */}
          <Card>
            <div className="p-4 sm:p-5 border-b border-ink-200 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-ink-50/60 to-white">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StethoscopeIcon className="size-5 text-brand-600" />
                  <h3 className="text-base font-bold text-ink-900">Doctor Directory & Capacities</h3>
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-800">
                    {activeDoctorCount} Active / {doctors.length} Total
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  Manage doctor profiles, consultation fees, daily token quotas, and linked login accounts
                </p>
              </div>

              {/* Search, Filter & Add Doctor Button */}
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative min-w-[160px] sm:min-w-[200px]">
                  <SearchIcon className="size-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={doctorSearch}
                    onChange={(e) => setDoctorSearch(e.target.value)}
                    placeholder="Search doctor or specialty..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-ink-300 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600 bg-white"
                  />
                  {doctorSearch ? (
                    <button
                      type="button"
                      onClick={() => setDoctorSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-600"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>

                {branches.length > 1 ? (
                  <select
                    value={doctorBranchFilter}
                    onChange={(e) => setDoctorBranchFilter(e.target.value)}
                    className="rounded-lg border border-ink-300 bg-white px-2.5 py-1.5 text-xs text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-600 cursor-pointer"
                  >
                    <option value="">All Branches</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : null}

                {branches.length > 0 ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={() => setIsAddDoctorOpen(true)}
                    className="shrink-0 gap-1.5 shadow-xs"
                  >
                    <PlusIcon className="size-4" />
                    <span>Add Doctor</span>
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Walk-in reservation policy banner */}
            <div className="px-5 py-2.5 bg-blue-50/70 border-b border-blue-100 flex items-center gap-2 text-xs text-blue-900">
              <InfoIcon className="size-4 text-blue-600 shrink-0" />
              <span>
                <strong>Walk-in & Quota Policy:</strong> Tokens 1–N are reserved for walk-ins arriving early; remaining capacity is shared between online bookings and queue tickets. Unused walk-in tokens release automatically when OPD starts.
              </span>
            </div>

            {filteredDoctors.length === 0 ? (
              <EmptyState
                title={doctors.length === 0 ? 'No doctors yet' : 'No matching doctors'}
                hint={
                  doctors.length === 0
                    ? 'Add a branch facility first, then register your first doctor.'
                    : 'Try clearing your search query or branch filter.'
                }
              />
            ) : (
              <div className="divide-y divide-ink-200">
                {filteredDoctors.map((doctor) => {
                  const isExpanded = expandedDoctorId === doctor.id;
                  const feeValue = fees[doctor.id];
                  const feeDisplay = feeValue ? `₹${feeValue / 100}` : 'Fee: Not set';

                  return (
                    <div
                      key={doctor.id}
                      className={cn(
                        'transition-colors',
                        !doctor.active && 'bg-ink-50/50 opacity-80',
                        isExpanded && 'bg-slate-50/40',
                      )}
                    >
                      {/* Compact Collapsed Row (h-16 flex) */}
                      <div className="p-4 sm:px-5 flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <div
                          className="min-w-0 flex-1 flex flex-wrap items-center gap-3 cursor-pointer"
                          onClick={() => setExpandedDoctorId(isExpanded ? null : doctor.id)}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm sm:text-base font-bold text-ink-900 truncate">
                                {doctor.name}
                              </p>
                              {doctor.active ? (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                                  Active
                                </span>
                              ) : (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900 shrink-0">
                                  Inactive
                                </span>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-ink-600">
                              {doctor.specialty ? (
                                <span className="inline-flex items-center gap-1 font-medium text-ink-800 bg-ink-100 px-2 py-0.5 rounded-md">
                                  <StethoscopeIcon className="size-3 text-brand-600" />
                                  {doctor.specialty}
                                </span>
                              ) : null}
                              {doctor.branchName ? (
                                <span className="inline-flex items-center gap-1 text-ink-600 bg-ink-100 px-2 py-0.5 rounded-md">
                                  <MapPinIcon className="size-3 text-ink-500" />
                                  {doctor.branchName}
                                </span>
                              ) : null}
                              <span className="inline-flex items-center gap-1 text-ink-600 bg-ink-100 px-2 py-0.5 rounded-md">
                                <ClockIcon className="size-3 text-ink-500" />
                                ~{doctor.defaultConsultMinutes}m
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Summary Metrics & Actions */}
                        <div className="flex items-center justify-between md:justify-end gap-3 pt-2 md:pt-0 border-t md:border-t-0 border-ink-100">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-md">
                              {feeDisplay}
                            </span>
                            <span className="text-ink-600 bg-ink-100 px-2 py-1 rounded-md hidden sm:inline-block">
                              Quota: {doctor.dailyTokenQuota ?? '∞'}
                            </span>
                          </div>

                          <form action={toggleDoctorAction} className="shrink-0">
                            <input type="hidden" name="doctorId" value={doctor.id} />
                            <input type="hidden" name="active" value={doctor.active ? 'false' : 'true'} />
                            <Button
                              type="submit"
                              size="sm"
                              variant={doctor.active ? 'secondary' : 'primary'}
                              className="text-xs py-1"
                            >
                              {doctor.active ? 'Deactivate' : 'Activate'}
                            </Button>
                          </form>

                          <button
                            type="button"
                            onClick={() => setExpandedDoctorId(isExpanded ? null : doctor.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg border border-ink-300 bg-white hover:bg-ink-50 text-ink-700 transition-colors cursor-pointer"
                          >
                            <span>{isExpanded ? 'Collapse' : 'Edit Details'}</span>
                            {isExpanded ? (
                              <ChevronDownIcon className="size-3.5 text-ink-500" />
                            ) : (
                              <ChevronRightIcon className="size-3.5 text-ink-500" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Smooth Expanded Accordion Body */}
                      {isExpanded ? (
                        <div className="border-t border-ink-200 p-4 sm:p-6 bg-slate-50/70 space-y-5 animate-in slide-in-from-top-2 duration-150">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-start">
                            {/* 1. Consultation Fee Form */}
                            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-3">
                              <div className="border-b border-ink-100 pb-2">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700 flex items-center gap-1.5">
                                  <span>Consultation Fee</span>
                                </h4>
                                <p className="text-[11px] text-ink-500 mt-0.5">Applied to future billings</p>
                              </div>

                              <SaveForm
                                action={setConsultationFeeAction}
                                justSaved={searchParams.saved === 'fee' && searchParams.id === doctor.id}
                                className="space-y-3"
                              >
                                <input type="hidden" name="doctorId" value={doctor.id} />
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-ink-600">
                                    Consultation fee (₹)
                                  </span>
                                  <Input
                                    name="fee"
                                    type="text"
                                    inputMode="decimal"
                                    defaultValue={feeValue !== undefined ? String(feeValue / 100) : ''}
                                    placeholder="e.g. 500"
                                    required
                                    className="py-1.5 text-sm"
                                  />
                                </label>
                                <div className="pt-1 flex justify-end">
                                  <SaveButton label="Save fee" />
                                </div>
                              </SaveForm>
                            </div>

                            {/* 2. Token Quota & Walk-in Reservations */}
                            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-3">
                              <div className="border-b border-ink-100 pb-2">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                                  Daily Capacity & Booking
                                </h4>
                                <p className="text-[11px] text-ink-500 mt-0.5">Walk-ins vs online booking rules</p>
                              </div>

                              <SaveForm
                                action={setDoctorCapacityAction}
                                justSaved={
                                  (searchParams.saved === 'capacity' ||
                                    searchParams.saved === 'capacity_above_plan') &&
                                  searchParams.id === doctor.id
                                }
                                className="space-y-3"
                              >
                                <input type="hidden" name="doctorId" value={doctor.id} />
                                <div className="grid grid-cols-2 gap-2.5">
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-medium text-ink-600 truncate">
                                      Daily token quota
                                    </span>
                                    <Input
                                      name="dailyQuota"
                                      type="number"
                                      min={1}
                                      defaultValue={doctor.dailyTokenQuota ?? ''}
                                      placeholder="No limit"
                                      className="py-1.5 text-xs"
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-medium text-ink-600 truncate">
                                      Reserved walk-ins
                                    </span>
                                    <Input
                                      name="walkInReserved"
                                      type="number"
                                      min={0}
                                      defaultValue={doctor.walkInReserved}
                                      className="py-1.5 text-xs"
                                    />
                                  </label>
                                </div>

                                <div className="grid grid-cols-2 gap-2.5">
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-medium text-ink-600 truncate">
                                      Online opens (min before)
                                    </span>
                                    <Input
                                      name="onlineOpensMinutesBefore"
                                      type="number"
                                      min={0}
                                      max={720}
                                      defaultValue={doctor.onlineOpensMinutesBefore}
                                      className="py-1.5 text-xs"
                                    />
                                  </label>
                                  <label className="block">
                                    <span className="mb-1 block text-xs font-medium text-ink-600 truncate">
                                      Release unused (min after)
                                    </span>
                                    <Input
                                      name="walkInReleaseMinutes"
                                      type="number"
                                      min={0}
                                      max={720}
                                      defaultValue={doctor.walkInReleaseMinutes ?? ''}
                                      placeholder="0 = at Start"
                                      className="py-1.5 text-xs"
                                    />
                                  </label>
                                </div>

                                <div className="pt-1 flex justify-end">
                                  <SaveButton label="Save quota" />
                                </div>
                              </SaveForm>
                            </div>

                            {/* 3. Linked Login & Mode */}
                            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-2xs space-y-3">
                              <div className="border-b border-ink-100 pb-2">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                                  Account Link & Practice Mode
                                </h4>
                                <p className="text-[11px] text-ink-500 mt-0.5">Authorizes prescription signing</p>
                              </div>

                              <SaveForm
                                action={linkDoctorAccountAction}
                                justSaved={searchParams.saved === 'link' && searchParams.id === doctor.id}
                                className="space-y-3"
                              >
                                <input type="hidden" name="doctorId" value={doctor.id} />
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-ink-600">
                                    Linked user login
                                  </span>
                                  <select
                                    name="userId"
                                    defaultValue={doctor.userId ?? ''}
                                    className="block w-full rounded-lg border-0 bg-white px-3 py-2 text-xs text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 cursor-pointer"
                                  >
                                    <option value="">Not linked — cannot write prescriptions</option>
                                    {staff
                                      .filter((member) => member.active || member.userId === doctor.userId)
                                      .map((member) => (
                                        <option key={member.userId} value={member.userId}>
                                          {member.name} ({member.role})
                                        </option>
                                      ))}
                                  </select>
                                </label>

                                <div className="pt-1 flex justify-end">
                                  <SaveButton label="Save login" />
                                </div>
                              </SaveForm>

                              <div className="pt-2 border-t border-ink-100">
                                <span className="text-[11px] font-semibold text-ink-500 block mb-1">
                                  Operating Mode:
                                </span>
                                <span
                                  className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold border',
                                    doctor.mode === 'both'
                                      ? 'bg-amber-50 text-amber-900 border-amber-200'
                                      : doctor.mode === 'slot'
                                      ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                                      : 'bg-blue-50 text-blue-900 border-blue-200',
                                  )}
                                >
                                  {doctor.mode === 'both' ? (
                                    <>
                                      <LayersIcon className="size-3 text-amber-700" />
                                      <span>Hybrid (Queue + Time Slots)</span>
                                    </>
                                  ) : doctor.mode === 'slot' ? (
                                    <>
                                      <ClockIcon className="size-3 text-emerald-700" />
                                      <span>Time Slots Only</span>
                                    </>
                                  ) : (
                                    <>
                                      <ActivityIcon className="size-3 text-blue-700" />
                                      <span>Live Queue Only</span>
                                    </>
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* 6. Tab 3: Staff & RBAC */}
      {activeTab === 'staff' ? (
        <div className="space-y-6 animate-in fade-in-50 duration-200">
          <Card>
            {/* Header Bar */}
            <div className="p-4 sm:p-5 border-b border-ink-200 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-ink-50/60 to-white">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldIcon className="size-5 text-brand-600" />
                  <h3 className="text-base font-bold text-ink-900">Hospital Staff Directory</h3>
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-800">
                    {activeStaffCount} Active / {staff.length} Total
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  Manage receptionists, doctors, nurses, and administrators across hospital branches
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {/* Search Bar */}
                <div className="relative min-w-[180px] sm:min-w-[220px]">
                  <SearchIcon className="size-3.5 text-ink-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={staffSearch}
                    onChange={(e) => setStaffSearch(e.target.value)}
                    placeholder="Search staff by name or email..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-ink-300 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600 bg-white"
                  />
                  {staffSearch ? (
                    <button
                      type="button"
                      onClick={() => setStaffSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-600"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>

                {/* Add Staff Button */}
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => setIsAddStaffOpen(true)}
                  className="shrink-0 gap-1.5 shadow-xs"
                >
                  <PlusIcon className="size-4" />
                  <span>Add Staff Member</span>
                </Button>
              </div>
            </div>

            {/* Role Filter Pills */}
            <div className="px-5 py-2.5 border-b border-ink-100 flex items-center gap-1.5 overflow-x-auto no-scrollbar bg-slate-50/40">
              <span className="text-xs font-semibold text-ink-500 mr-1.5 shrink-0">Filter Role:</span>
              {(['all', 'owner', 'receptionist', 'doctor', 'nurse'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setStaffRoleFilter(r)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer whitespace-nowrap',
                    staffRoleFilter === r
                      ? 'bg-ink-900 text-white shadow-2xs'
                      : 'bg-white text-ink-600 hover:bg-ink-100 border border-ink-200',
                  )}
                >
                  {r === 'all'
                    ? 'All Roles'
                    : r === 'owner'
                    ? 'Admin / Owner'
                    : r.charAt(0).toUpperCase() + r.slice(1)}
                </button>
              ))}
            </div>

            {/* Full-Width Staff Directory Table */}
            <div className="p-4 sm:p-5">
              {filteredStaff.length === 0 ? (
                <EmptyState
                  title={staff.length === 0 ? 'No staff accounts' : 'No matching staff members'}
                  hint={
                    staff.length === 0
                      ? 'Click "+ Add Staff Member" above to create credentials for your team.'
                      : 'Try adjusting your search query or role filter.'
                  }
                />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-ink-200 shadow-2xs">
                  <table className="w-full text-left text-xs divide-y divide-ink-200">
                    <thead className="bg-ink-50/80 text-ink-600 font-bold uppercase tracking-wider text-[11px]">
                      <tr>
                        <th className="px-4 py-3">Staff Member</th>
                        <th className="px-4 py-3">Role</th>
                        <th className="px-4 py-3">Assigned Branch</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100 bg-white">
                      {filteredStaff.map((member) => (
                        <tr key={member.id} className="hover:bg-ink-50/60 transition-colors">
                          <td className="px-4 py-3.5">
                            <p className="font-bold text-sm text-ink-900">{member.name}</p>
                            <p className="text-xs text-ink-500 font-mono mt-0.5">{member.email}</p>
                          </td>
                          <td className="px-4 py-3.5">
                            <span
                              className={cn(
                                'rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider inline-block border',
                                member.role === 'owner'
                                  ? 'bg-purple-50 text-purple-800 border-purple-200'
                                  : member.role === 'receptionist'
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : member.role === 'nurse'
                                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                                  : 'bg-blue-50 text-blue-800 border-blue-200',
                              )}
                            >
                              {member.role === 'owner' ? 'Admin / Owner' : member.role}
                            </span>
                          </td>
                          <td className="px-4 py-3.5 text-ink-700">
                            {member.branchName ? (
                              <span className="inline-flex items-center gap-1 font-medium bg-ink-100 px-2 py-0.5 rounded-md">
                                <MapPinIcon className="size-3 text-ink-500" />
                                {member.branchName}
                              </span>
                            ) : (
                              <span className="text-ink-400 italic">All Branches</span>
                            )}
                          </td>
                          <td className="px-4 py-3.5">
                            {member.active ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                                <span className="size-1.5 rounded-full bg-emerald-500" /> Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <form action={toggleStaffAction} className="inline-block">
                              <input type="hidden" name="membershipId" value={member.id} />
                              <input
                                type="hidden"
                                name="active"
                                value={member.active ? 'false' : 'true'}
                              />
                              <Button
                                type="submit"
                                size="sm"
                                variant={member.active ? 'secondary' : 'primary'}
                                className="py-1 text-xs"
                              >
                                {member.active ? 'Deactivate' : 'Activate'}
                              </Button>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      {/* 7. Tab 4: Scheduling Rules */}
      {activeTab === 'scheduling' ? (
        <div className="space-y-6 animate-in fade-in-50 duration-200">
          {doctors.length === 0 ? (
            <Card>
              <EmptyState
                title="No doctors registered yet"
                hint="Register at least one doctor under the 'Clinic & Doctors' tab to configure scheduling rules."
              />
            </Card>
          ) : (
            <DoctorScheduleManager doctors={doctors} initialDate={today} />
          )}
        </div>
      ) : null}

      {/* 8. Modal: Add New Branch */}
      {isAddBranchOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-ink-200 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4 bg-ink-50/50">
              <div>
                <h3 className="text-base font-bold text-ink-900">Add New Branch</h3>
                <p className="text-xs text-ink-500">Register a new physical OPD or hospital building</p>
              </div>
              <button
                type="button"
                onClick={() => setIsAddBranchOpen(false)}
                className="rounded-lg p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 transition-colors"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            <form action={addBranchAction} className="p-5 space-y-4">
              <Field label="Branch name">
                <Input name="name" required placeholder="e.g. Main Hospital / OPD Wing" autoFocus />
              </Field>
              <Field label="Address" hint="Optional">
                <Input name="address" placeholder="Station Road, Satara" />
              </Field>
              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-ink-100">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setIsAddBranchOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Create Branch
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* 9. Modal / Slide-over Drawer: Add New Doctor */}
      {isAddDoctorOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-ink-200 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4 bg-ink-50/50">
              <div>
                <h3 className="text-base font-bold text-ink-900">Add New Doctor</h3>
                <p className="text-xs text-ink-500">Configure doctor credentials, specialty & schedule mode</p>
              </div>
              <button
                type="button"
                onClick={() => setIsAddDoctorOpen(false)}
                className="rounded-lg p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 transition-colors"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            <form action={addDoctorAction} className="p-5 space-y-4">
              <Field label="Doctor Full Name">
                <Input name="name" required placeholder="Dr. Anjali Deshmukh" autoFocus />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Specialty" hint="Optional">
                  <Input name="specialty" placeholder="e.g. Paediatrics, Cardiology" />
                </Field>

                <Field label="Primary Branch">
                  <select
                    name="branchId"
                    required
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field
                label="Practice / Schedule Mode"
                hint="Hybrid supports both live same-day tokens and advance scheduled slots."
              >
                <select
                  name="mode"
                  defaultValue="both"
                  className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                >
                  <option value="both">Hybrid (Both: Live Queue & Time Slots)</option>
                  <option value="queue">Live Running Queue Only (Visiting / Walk-ins)</option>
                  <option value="slot">Time-based Appointment Slots Only</option>
                </select>
              </Field>

              <Field
                label="Typical consultation length (minutes)"
                hint="Used for queue wait estimates until consultations are recorded."
              >
                <Input
                  name="defaultConsultMinutes"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={10}
                />
              </Field>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-ink-100">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setIsAddDoctorOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Register Doctor
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* 10. Modal / Slide-over Drawer: Add New Staff Member */}
      {isAddStaffOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-ink-200 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4 bg-ink-50/50">
              <div>
                <h3 className="text-base font-bold text-ink-900">Create Staff User Account</h3>
                <p className="text-xs text-ink-500">Provide login credentials and role assignment</p>
              </div>
              <button
                type="button"
                onClick={() => setIsAddStaffOpen(false)}
                className="rounded-lg p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 transition-colors"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            <form action={addStaffAction} className="p-5 space-y-4">
              <Field label="Full Name">
                <Input name="name" required placeholder="Priya Kulkarni" autoFocus />
              </Field>
              <Field label="Email Address" hint="Used for dashboard sign-in">
                <Input name="email" type="email" required placeholder="priya@hospital.com" />
              </Field>
              <Field
                label="Temporary Password"
                hint="At least 10 characters. Must be changed at first sign-in."
              >
                <Input
                  name="password"
                  type="text"
                  autoComplete="off"
                  required
                  minLength={10}
                  placeholder="Provide at least 10 characters"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Role">
                  <select
                    name="role"
                    defaultValue="receptionist"
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                  >
                    <option value="receptionist">Receptionist</option>
                    <option value="doctor">Doctor</option>
                    <option value="nurse">Nurse (IPD Ward)</option>
                    <option value="owner">Hospital Owner / Admin</option>
                  </select>
                </Field>
                <Field label="Branch Assignment" hint="Optional">
                  <select
                    name="branchId"
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                  >
                    <option value="">All Branches / None</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-ink-100">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setIsAddStaffOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Create Staff Account
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
