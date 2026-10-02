import { describe, expect, it } from 'vitest';
import { isDevanagari, toDevanagariNumerals, transliterateToMarathi } from '../indic';

describe('indic utilities', () => {
  it('detects Devanagari characters accurately', () => {
    expect(isDevanagari('रमेश पाटील')).toBe(true);
    expect(isDevanagari('Dr. Rahul')).toBe(false);
    expect(isDevanagari('Amit 123')).toBe(false);
    expect(isDevanagari('प')).toBe(true);
    expect(isDevanagari('')).toBe(false);
  });

  it('converts numbers to Devanagari numerals', () => {
    expect(toDevanagariNumerals(14)).toBe('१४');
    expect(toDevanagariNumerals(0)).toBe('०');
    expect(toDevanagariNumerals(98230)).toBe('९८२३०');
    expect(toDevanagariNumerals('Token #5')).toBe('Token #५');
  });

  it('returns already-Devanagari strings immediately', async () => {
    const marathiName = 'सुरेश जाधव';
    const res = await transliterateToMarathi(marathiName);
    expect(res).toBe(marathiName);
  });

  it('accurately translates multi-speciality without phonetic distortion', async () => {
    expect(await transliterateToMarathi('Multispeciality')).toBe('मल्टीस्पेशालिटी');
    expect(await transliterateToMarathi('Multi-speciality')).toBe('मल्टीस्पेशालिटी');
    expect(await transliterateToMarathi('multi-speciality')).toBe('मल्टीस्पेशालिटी');
    expect(await transliterateToMarathi('Multi Speciality')).toBe('मल्टीस्पेशालिटी');
    expect(await transliterateToMarathi('Multispecialty')).toBe('मल्टीस्पेशालिटी');
    expect(await transliterateToMarathi('Super-speciality')).toBe('सुपरस्पेशालिटी');
    expect(await transliterateToMarathi('Super Speciality Hospital')).toBe('सुपरस्पेशालिटी हॉस्पिटल');
  });

  it('accurately translates medical and hospital phrases', async () => {
    expect(await transliterateToMarathi('Multispeciality Hospital')).toBe('मल्टीस्पेशालिटी हॉस्पिटल');
    expect(await transliterateToMarathi('Multi-speciality Hospital')).toBe('मल्टीस्पेशालिटी हॉस्पिटल');
    expect(await transliterateToMarathi('Main Branch')).toBe('मुख्य शाखा');
    expect(await transliterateToMarathi('City Branch')).toBe('शहर शाखा');
    expect(await transliterateToMarathi('Lunch Break')).toBe('दुपारचे जेवण');
    expect(await transliterateToMarathi('In Surgery')).toBe('शस्त्रक्रिया चालू');
    expect(await transliterateToMarathi('Ward Round')).toBe('वॉर्ड राऊंड');
  });

  it('translates compound hospital names properly without blunder terms', async () => {
    const hospital = await transliterateToMarathi('Sunrise Multispeciality Hospital');
    expect(hospital).toContain('मल्टीस्पेशालिटी');
    expect(hospital).toContain('हॉस्पिटल');
    expect(hospital).not.toContain('मुलतीस्पेसिलीटी');
  });

  it('translates Dr. and doctor prefixes to डॉ. instead of दर, with no double dots', async () => {
    expect(await transliterateToMarathi('Dr.')).toBe('डॉ.');
    expect(await transliterateToMarathi('DR.')).toBe('डॉ.');
    expect(await transliterateToMarathi('Dr')).toBe('डॉ.');
    expect(await transliterateToMarathi('Doctor')).toBe('डॉक्टर');
    const doc = await transliterateToMarathi('Dr. Ramesh Patil');
    expect(doc).toBe('डॉ. रमेश पाटील');
    expect(doc).not.toContain('डॉ..');
    expect(doc).not.toContain('दर');
  });

  it('translates patient names offline accurately', async () => {
    expect(await transliterateToMarathi('Ramesh Patil')).toBe('रमेश पाटील');
    expect(await transliterateToMarathi('Suresh Jadhav')).toBe('सुरेश जाधव');
    expect(await transliterateToMarathi('Rahul Sharma')).toBe('राहुल शर्मा');
    expect(await transliterateToMarathi('Pooja Shinde')).toBe('पूजा शिंदे');
  });
});
