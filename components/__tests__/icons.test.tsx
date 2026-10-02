import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  StethoscopeIcon,
  TvIcon,
  ClockIcon,
  PhoneIcon,
  UserPlusIcon,
  BuildingIcon,
  MapPinIcon,
  ZapIcon,
  SettingsIcon,
  ShieldIcon,
  BarChartIcon,
  CreditCardIcon,
  FileTextIcon,
  LayersIcon,
  AlertTriangleIcon,
  InfoIcon,
  CalendarIcon,
  CheckIcon,
  XIcon,
  MenuIcon,
  UserIcon,
  PauseIcon,
  ChevronRightIcon,
  PlusIcon,
  TagIcon,
  PillIcon,
  ActivityIcon,
  BellIcon,
  BellOffIcon,
  BedIcon,
  UndoIcon,
  SyringeIcon,
  SearchIcon,
  ArrowLeftIcon,
  WifiOffIcon,
} from '../icons';

describe('Centralized SVG Iconography', () => {
  it('exports all standard clinical and system icons', () => {
    expect(StethoscopeIcon).toBeDefined();
    expect(TvIcon).toBeDefined();
    expect(ClockIcon).toBeDefined();
    expect(PhoneIcon).toBeDefined();
    expect(UserPlusIcon).toBeDefined();
    expect(BuildingIcon).toBeDefined();
    expect(MapPinIcon).toBeDefined();
    expect(ZapIcon).toBeDefined();
    expect(SettingsIcon).toBeDefined();
    expect(ShieldIcon).toBeDefined();
    expect(BarChartIcon).toBeDefined();
    expect(CreditCardIcon).toBeDefined();
    expect(FileTextIcon).toBeDefined();
    expect(LayersIcon).toBeDefined();
    expect(AlertTriangleIcon).toBeDefined();
    expect(InfoIcon).toBeDefined();
    expect(CalendarIcon).toBeDefined();
    expect(CheckIcon).toBeDefined();
    expect(XIcon).toBeDefined();
    expect(MenuIcon).toBeDefined();
    expect(UserIcon).toBeDefined();
    expect(PauseIcon).toBeDefined();
    expect(ChevronRightIcon).toBeDefined();
    expect(PlusIcon).toBeDefined();
    expect(TagIcon).toBeDefined();
    expect(PillIcon).toBeDefined();
    expect(ActivityIcon).toBeDefined();
    expect(BellIcon).toBeDefined();
    expect(BellOffIcon).toBeDefined();
  });

  it('exports the IPD icons, decorative like the rest', () => {
    for (const Icon of [BedIcon, UndoIcon, SyringeIcon, SearchIcon, ArrowLeftIcon, WifiOffIcon]) {
      const el = Icon({});
      expect(el.type).toBe('svg');
      expect(el.props['aria-hidden']).toBe('true');
    }
  });

  it('renders SVG elements with appropriate default attributes', () => {
    const el = StethoscopeIcon({ className: 'custom-class' });
    expect(el.type).toBe('svg');
    expect(el.props['aria-hidden']).toBe('true');
    expect(el.props.viewBox).toBe('0 0 24 24');
    expect(el.props.className).toContain('custom-class');
  });
});
