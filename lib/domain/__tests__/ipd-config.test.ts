import { describe, expect, it } from 'vitest';
import {
  CHARGE_ITEM_KINDS,
  MAX_BEDS_PER_RANGE,
  compareBedLabels,
  parseBedLabels,
  parseChargeItemCsv,
  parseChargeItemInput,
  parsePriceEdits,
  splitCsvLine,
} from '../ipd-config';
import { STARTER_CHARGE_ITEMS } from '../starter-charge-items';

const labels = (input: string) => {
  const result = parseBedLabels(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe('parseBedLabels', () => {
  it('turns a range into one bed per number', () => {
    expect(labels('1-12')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(labels('1–3')).toEqual(['1', '2', '3']);
  });

  it('keeps a prefix, repeated or not', () => {
    expect(labels('A1-A3')).toEqual(['A1', 'A2', 'A3']);
    expect(labels('A1-3')).toEqual(['A1', 'A2', 'A3']);
    expect(labels('ICU 1-2')).toEqual(['ICU 1', 'ICU 2']);
  });

  it('reads a hyphenated name as one bed, not a range', () => {
    expect(labels('ICU-3')).toEqual(['ICU-3']);
  });

  it('accepts lists and drops duplicates', () => {
    expect(labels('1, 2, 5')).toEqual(['1', '2', '5']);
    expect(labels('1-3, 2, a1, A1')).toEqual(['1', '2', '3', 'a1']);
  });

  it('reads a single number as how many beds, numbered from 1', () => {
    expect(labels('12')).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(labels('1')).toEqual(['1']);
  });

  it('numbers more beds after the ward’s highest bed', () => {
    const more = parseBedLabels('4', ['1', '2', '12', 'ICU-1']);
    expect(more).toEqual({ ok: true, value: ['13', '14', '15', '16'] });
  });

  it('still makes one exact bed from a one-number range', () => {
    expect(labels('13-13')).toEqual(['13']);
  });

  it('refuses zero beds or too many at once', () => {
    expect(parseBedLabels('0').ok).toBe(false);
    expect(parseBedLabels(String(MAX_BEDS_PER_RANGE + 1)).ok).toBe(false);
  });

  it('refuses nothing, a backwards range, or a flood', () => {
    expect(parseBedLabels('  ').ok).toBe(false);
    expect(parseBedLabels('12-1').ok).toBe(false);
    expect(parseBedLabels(`1-${MAX_BEDS_PER_RANGE + 1}`).ok).toBe(false);
  });
});

describe('compareBedLabels', () => {
  it('sorts the way a ward is walked', () => {
    expect(['10', '2', '1', 'A10', 'A2'].sort(compareBedLabels)).toEqual([
      '1',
      '2',
      '10',
      'A2',
      'A10',
    ]);
  });
});

describe('parseChargeItemInput', () => {
  it('tidies the name and defaults the unit by kind', () => {
    const result = parseChargeItemInput({ kind: 'room', name: '  General   ward bed ' });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'room',
        name: 'General ward bed',
        unit: 'day',
        sellingPricePaise: null,
        taxRateBp: 0,
        isTest: false,
      },
    });
  });

  it('only lets a service be a test', () => {
    const consumable = parseChargeItemInput({ kind: 'consumable', name: 'Gloves', isTest: true });
    expect(consumable.ok && consumable.value.isTest).toBe(false);
    const service = parseChargeItemInput({ kind: 'service', name: 'CBC', isTest: true });
    expect(service.ok && service.value.isTest).toBe(true);
  });

  it('refuses a missing name or an unknown kind', () => {
    expect(parseChargeItemInput({ kind: 'consumable', name: '  ' }).ok).toBe(false);
    expect(parseChargeItemInput({ kind: 'medicine', name: 'Paracetamol' }).ok).toBe(false);
  });
});

describe('splitCsvLine', () => {
  it('handles quoted commas and doubled quotes', () => {
    expect(splitCsvLine('"Dressing, large",procedure,each,250')).toEqual([
      'Dressing, large',
      'procedure',
      'each',
      '250',
    ]);
    expect(splitCsvLine('"Ryle""s tube",consumable')).toEqual(['Ryle"s tube', 'consumable']);
  });

  it('accepts tab-separated text pasted from a spreadsheet', () => {
    expect(splitCsvLine('Gloves\tconsumable\tpair\t12')).toEqual(['Gloves', 'consumable', 'pair', '12']);
  });
});

describe('parseChargeItemCsv', () => {
  it('skips the header, converts rupees to paise and percent to basis points', () => {
    const preview = parseChargeItemCsv(
      'name,kind,unit,price,tax\nSyringe 5 ml,consumable,syringe,15,12\nCBC,test,,350,\n',
    );
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toEqual([
      {
        line: 2,
        name: 'Syringe 5 ml',
        kind: 'consumable',
        unit: 'syringe',
        sellingPricePaise: 1500,
        taxRateBp: 1200,
        isTest: false,
      },
      {
        line: 3,
        name: 'CBC',
        kind: 'service',
        unit: 'each',
        sellingPricePaise: 35000,
        taxRateBp: 0,
        isTest: true,
      },
    ]);
  });

  it('keeps a blank price as not priced yet, and defaults the kind', () => {
    const preview = parseChargeItemCsv('Gauze');
    expect(preview.rows[0]).toMatchObject({ kind: 'consumable', sellingPricePaise: null });
  });

  it('reports each bad row by line and still returns the good ones', () => {
    const preview = parseChargeItemCsv(
      ['Gloves,consumable,pair,12', ',consumable', 'Oxygen,gas,hour,50', 'ECG,service,each,abc', 'Gloves,consumable'].join(
        '\n',
      ),
    );
    expect(preview.rows.map((row) => row.name)).toEqual(['Gloves']);
    expect(preview.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(preview.errors[1].error).toMatch(/Kind “gas”/);
    expect(preview.errors[3].error).toMatch(/twice/);
  });
});

describe('parsePriceEdits', () => {
  const id = '6f1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90';

  it('reads only filled price boxes', () => {
    expect(
      parsePriceEdits([
        [`price:${id}`, '2.50'],
        ['price:1e1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90', ''],
        ['q', 'para'],
      ]),
    ).toEqual({ ok: true, value: [{ id, sellingPricePaise: 250 }] });
  });

  it('refuses the whole form on one unreadable amount', () => {
    expect(parsePriceEdits([[`price:${id}`, 'two']]).ok).toBe(false);
  });
});

describe('STARTER_CHARGE_ITEMS', () => {
  it('has no duplicate identities (kind + name, any case)', () => {
    const keys = STARTER_CHARGE_ITEMS.map((item) => `${item.kind}:${item.name.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses only valid kinds and only flags services as tests', () => {
    for (const item of STARTER_CHARGE_ITEMS) {
      expect(CHARGE_ITEM_KINDS).toContain(item.kind);
      if (item.isTest) expect(item.kind).toBe('service');
    }
  });

  it('passes the same validation as an owner-typed item, and carries no price', () => {
    for (const item of STARTER_CHARGE_ITEMS) {
      const parsed = parseChargeItemInput(item);
      expect(parsed.ok).toBe(true);
      expect('sellingPricePaise' in item).toBe(false);
    }
  });

  it('covers every kind, including room charges and at least ten tests', () => {
    for (const kind of CHARGE_ITEM_KINDS) {
      expect(STARTER_CHARGE_ITEMS.some((item) => item.kind === kind)).toBe(true);
    }
    expect(STARTER_CHARGE_ITEMS.filter((item) => item.isTest).length).toBeGreaterThanOrEqual(10);
  });
});
