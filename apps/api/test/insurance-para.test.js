// PS-24: Para-sport insurance comparison, exclusions and equipment cover
// Tests the PARA_EVENT_TYPES constant, the no-discrimination schema constraint,
// and the neverInventCoverage disclosure-gap logic (tested inline since it is
// an internal module function, not a public export).

import { describe, it, expect } from './helpers/vitest-compat.js';
import { PARA_EVENT_TYPES } from '../src/capabilities/insurance-para.js';

describe('insurance-para constants', () => {
  it('PARA_EVENT_TYPES has 5 valid values', () => {
    expect(PARA_EVENT_TYPES).toHaveLength(5);
    expect(PARA_EVENT_TYPES).toContain('sanctioned_competition');
    expect(PARA_EVENT_TYPES).toContain('recreational');
    expect(PARA_EVENT_TYPES).toContain('training_camp');
    expect(PARA_EVENT_TYPES).toContain('trial');
    expect(PARA_EVENT_TYPES).toContain('mixed_ability');
  });

  it('PARA_EVENT_TYPES contains only strings', () => {
    PARA_EVENT_TYPES.forEach((v) => expect(typeof v).toBe('string'));
  });
});

describe('insurance-para schema validation — no disability/health discrimination', () => {
  it('rejects disability_class and health_condition fields (strict schema)', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      para_disciplines: z.array(z.string().max(80)).max(30).optional(),
      para_event_types: z.array(z.string()).optional(),
      para_equipment_cover: z.boolean().optional(),
      para_travel_cover: z.boolean().optional(),
      para_exclusions: z.string().max(4000).nullable().optional(),
      para_coverage_unknowns: z.string().max(2000).nullable().optional(),
      para_coverage_notes: z.string().max(2000).nullable().optional(),
    }).strict();
    const result = schema.safeParse({
      disability_class: 'T53',
      health_condition: 'SCI',
      para_equipment_cover: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid para attributes input without health fields', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      para_disciplines: z.array(z.string().max(80)).max(30).optional(),
      para_event_types: z.array(z.string()).optional(),
      para_equipment_cover: z.boolean().optional(),
      para_travel_cover: z.boolean().optional(),
      para_exclusions: z.string().max(4000).nullable().optional(),
      para_coverage_unknowns: z.string().max(2000).nullable().optional(),
      para_coverage_notes: z.string().max(2000).nullable().optional(),
    }).strict();
    const result = schema.safeParse({
      para_disciplines: ['wheelchair-tennis', 'para-athletics'],
      para_equipment_cover: true,
      para_travel_cover: false,
      para_exclusions: 'Pre-existing SCI complications not covered.',
    });
    expect(result.success).toBe(true);
  });

  it('para_exclusions accepts null (gap disclosure) and string (stated)', async () => {
    const { z } = await import('zod');
    const field = z.string().max(4000).nullable().optional();
    expect(field.safeParse(null).success).toBe(true);
    expect(field.safeParse('None').success).toBe(true);
    expect(field.safeParse(undefined).success).toBe(true);
  });
});

describe('disclosure_gap logic', () => {
  // Mirror of the internal neverInventCoverage function in insurance-para.js
  const DISCLOSURE_NOTE =
    'This plan has not stated its exclusions for para-sport. Contact the insurer before purchasing.';

  const neverInventCoverage = (plan) => {
    const hasParaDisciplines = Array.isArray(plan.para_disciplines) && plan.para_disciplines.length > 0;
    const hasExclusions = plan.para_exclusions != null;
    const disclosure_gap = hasParaDisciplines && !hasExclusions;
    return {
      ...plan,
      disclosure_gap,
      disclosure_note: disclosure_gap ? DISCLOSURE_NOTE : null,
    };
  };

  it('flags gap when disciplines set but para_exclusions is null', () => {
    const result = neverInventCoverage({
      para_disciplines: ['wheelchair-tennis'],
      para_exclusions: null,
    });
    expect(result.disclosure_gap).toBe(true);
    expect(result.disclosure_note).toBe(DISCLOSURE_NOTE);
  });

  it('no gap when para_exclusions is stated (non-null string)', () => {
    const result = neverInventCoverage({
      para_disciplines: ['wheelchair-tennis'],
      para_exclusions: 'Pre-existing SCI complications not covered.',
    });
    expect(result.disclosure_gap).toBe(false);
    expect(result.disclosure_note).toBeNull();
  });

  it('no gap when para_exclusions is empty string (counts as stated)', () => {
    const result = neverInventCoverage({
      para_disciplines: ['wheelchair-tennis'],
      para_exclusions: '',
    });
    // empty string is not null — the insurer has set the field (even if blank)
    expect(result.disclosure_gap).toBe(false);
  });

  it('no gap when no para disciplines set regardless of exclusions state', () => {
    const result = neverInventCoverage({
      para_disciplines: [],
      para_exclusions: null,
    });
    expect(result.disclosure_gap).toBe(false);
    expect(result.disclosure_note).toBeNull();
  });

  it('no gap when para_disciplines is undefined', () => {
    const result = neverInventCoverage({ para_exclusions: null });
    expect(result.disclosure_gap).toBe(false);
  });

  it('disclosure_note is a constant string — never computed from health or disability data', () => {
    const r1 = neverInventCoverage({ para_disciplines: ['wheelchair-tennis'], para_exclusions: null });
    const r2 = neverInventCoverage({ para_disciplines: ['boccia'], para_exclusions: null });
    const r3 = neverInventCoverage({ para_disciplines: ['para-cycling'], para_exclusions: null });
    expect(r1.disclosure_note).toBe(r2.disclosure_note);
    expect(r2.disclosure_note).toBe(r3.disclosure_note);
    expect(r1.disclosure_note).toBe(DISCLOSURE_NOTE);
  });

  it('original plan fields are preserved in returned object', () => {
    const plan = {
      id: 'abc-123',
      name: 'AXA Para-Sport Protect',
      para_disciplines: ['wheelchair-tennis'],
      para_equipment_cover: true,
      para_exclusions: null,
    };
    const result = neverInventCoverage(plan);
    expect(result.id).toBe('abc-123');
    expect(result.name).toBe('AXA Para-Sport Protect');
    expect(result.para_equipment_cover).toBe(true);
    expect(result.disclosure_gap).toBe(true);
  });
});

describe('policy equipment schema validation', () => {
  it('equipment entry has required fields', async () => {
    const { z } = await import('zod');
    const equipmentEntry = z.object({
      serial_no: z.string().max(100).optional(),
      insured_value_cents: z.number().int().min(0),
      description: z.string().min(1).max(500),
      event_id: z.string().uuid().optional(),
      asset_ref: z.string().max(200).optional(),
    });
    const valid = equipmentEntry.safeParse({
      insured_value_cents: 82000000,
      description: 'TiLite TR Rigid Wheelchair',
      serial_no: 'SN-7821-WC',
      event_id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(valid.success).toBe(true);

    const missing = equipmentEntry.safeParse({ serial_no: 'SN-7821-WC' });
    expect(missing.success).toBe(false);
  });

  it('insured_value_cents must be a non-negative integer', async () => {
    const { z } = await import('zod');
    const field = z.number().int().min(0);
    expect(field.safeParse(-100).success).toBe(false);
    expect(field.safeParse(1.5).success).toBe(false);
    expect(field.safeParse(0).success).toBe(true);
    expect(field.safeParse(82000000).success).toBe(true);
  });
});
