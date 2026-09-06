import { describe, expect, it } from 'vitest';
import {
  categoriseMessage,
  isBillableStatus,
  MESSAGE_CATEGORIES,
  MESSAGE_CATEGORY_LABELS,
} from '../message-category';

describe('categoriseMessage', () => {
  it('categorises the token link as a confirmation', () => {
    expect(
      categoriseMessage({ templateCode: 'queue_link', milestone: 'queue_link' }),
    ).toBe('appointment_confirmation');
  });

  it('categorises the nudge as a queue notification', () => {
    expect(
      categoriseMessage({ templateCode: 'queue_milestone', milestone: 'queue_ahead_4' }),
    ).toBe('queue_notification');
  });

  it('groups every step of a booking conversation together', () => {
    for (const milestone of [
      'conversation:language',
      'conversation:doctor',
      'conversation:slot',
    ]) {
      expect(categoriseMessage({ templateCode: 'conversation', milestone })).toBe(
        'booking_conversation',
      );
    }
  });

  it('recognises a conversation from the milestone even if the template differs', () => {
    expect(
      categoriseMessage({ templateCode: 'something_else', milestone: 'conversation:doctor' }),
    ).toBe('booking_conversation');
  });

  it('separates the owner summary from patient messages', () => {
    expect(
      categoriseMessage({
        templateCode: 'owner_monthly_report',
        milestone: 'owner_report:2026-08',
      }),
    ).toBe('owner_report');
  });

  it('falls back to other rather than throwing on an unknown template', () => {
    // New templates must not break the usage dashboard.
    expect(categoriseMessage({ templateCode: 'future_template', milestone: 'x' })).toBe(
      'other',
    );
  });

  it('has a label for every category', () => {
    for (const category of MESSAGE_CATEGORIES) {
      expect(MESSAGE_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});

describe('isBillableStatus', () => {
  /**
   * Meta charges on delivery. A message that failed, or one the circuit breaker
   * dropped, reached nobody and must not consume a hospital's allowance.
   */
  it('counts only messages that were actually sent', () => {
    expect(isBillableStatus('sent')).toBe(true);
    for (const status of ['pending', 'sending', 'failed', 'suppressed']) {
      expect(isBillableStatus(status)).toBe(false);
    }
  });
});
