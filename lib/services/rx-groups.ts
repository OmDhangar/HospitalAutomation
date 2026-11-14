import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { rxGroups, rxGroupItems, medicines } from '@/lib/db/schema';

export class RxGroupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RxGroupValidationError';
  }
}

export class RxGroupNotFoundError extends Error {
  constructor(message: string = 'Rx Group not found') {
    super(message);
    this.name = 'RxGroupNotFoundError';
  }
}

export interface RxGroupItemView {
  id: string;
  medicineId: string;
  medicineName: string;
  dose: string;
  frequency: string;
  durationDays: number | null;
  instructions: string | null;
  sortOrder: number;
}

export interface RxGroupView {
  id: string;
  name: string;
  description: string | null;
  category: string;
  doctorId: string | null;
  isPersonal: boolean;
  defaultDiagnosis: string | null;
  defaultAdvice: string | null;
  defaultFollowUpDays: number | null;
  sortOrder: number;
  items: RxGroupItemView[];
}

export interface CreateRxGroupItemInput {
  medicineId: string;
  medicineName: string;
  dose: string;
  frequency: string;
  durationDays?: number | null;
  instructions?: string | null;
  sortOrder?: number;
}

export interface CreateRxGroupInput {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
  name: string;
  description?: string | null;
  category?: string;
  defaultDiagnosis?: string | null;
  defaultAdvice?: string | null;
  defaultFollowUpDays?: number | null;
  items: CreateRxGroupItemInput[];
}

/**
 * Lists all active Rx-Groups available to the doctor or hospital.
 * Returns hospital-wide groups (doctorId is NULL) and personal groups matching doctorId.
 */
export async function listRxGroups(args: {
  hospitalId: string;
  doctorId?: string | null;
  category?: string | null;
}): Promise<RxGroupView[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const conditions = [
      eq(rxGroups.hospitalId, args.hospitalId),
      eq(rxGroups.active, true),
    ];

    if (args.doctorId) {
      conditions.push(or(isNull(rxGroups.doctorId), eq(rxGroups.doctorId, args.doctorId))!);
    } else {
      conditions.push(isNull(rxGroups.doctorId));
    }

    if (args.category) {
      conditions.push(eq(rxGroups.category, args.category));
    }

    const groups = await tx
      .select()
      .from(rxGroups)
      .where(and(...conditions))
      .orderBy(asc(rxGroups.sortOrder), asc(rxGroups.name));

    if (groups.length === 0) {
      return [];
    }

    const groupIds = groups.map((g: any) => g.id);

    const items = await tx
      .select()
      .from(rxGroupItems)
      .where(
        and(
          eq(rxGroupItems.hospitalId, args.hospitalId),
          inArray(rxGroupItems.rxGroupId, groupIds),
        ),
      )
      .orderBy(asc(rxGroupItems.sortOrder));

    const itemMap = new Map<string, RxGroupItemView[]>();
    for (const item of items) {
      const list = itemMap.get(item.rxGroupId) || [];
      list.push({
        id: item.id,
        medicineId: item.medicineId,
        medicineName: item.medicineName,
        dose: item.dose,
        frequency: item.frequency,
        durationDays: item.durationDays,
        instructions: item.instructions,
        sortOrder: item.sortOrder,
      });
      itemMap.set(item.rxGroupId, list);
    }

    return groups.map((g: any) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      category: g.category,
      doctorId: g.doctorId,
      isPersonal: Boolean(g.doctorId),
      defaultDiagnosis: g.defaultDiagnosis,
      defaultAdvice: g.defaultAdvice,
      defaultFollowUpDays: g.defaultFollowUpDays,
      sortOrder: g.sortOrder,
      items: itemMap.get(g.id) || [],
    }));
  });
}

/**
 * Retrieves a single Rx-Group with its items by ID.
 */
export async function getRxGroupById(args: {
  hospitalId: string;
  rxGroupId: string;
}): Promise<RxGroupView | null> {
  return withTenant(args.hospitalId, async (tx) => {
    const [group] = await tx
      .select()
      .from(rxGroups)
      .where(
        and(
          eq(rxGroups.hospitalId, args.hospitalId),
          eq(rxGroups.id, args.rxGroupId),
          eq(rxGroups.active, true),
        ),
      );

    if (!group) return null;

    const items = await tx
      .select()
      .from(rxGroupItems)
      .where(
        and(
          eq(rxGroupItems.hospitalId, args.hospitalId),
          eq(rxGroupItems.rxGroupId, group.id),
        ),
      )
      .orderBy(asc(rxGroupItems.sortOrder));

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      category: group.category,
      doctorId: group.doctorId,
      isPersonal: Boolean(group.doctorId),
      defaultDiagnosis: group.defaultDiagnosis,
      defaultAdvice: group.defaultAdvice,
      defaultFollowUpDays: group.defaultFollowUpDays,
      sortOrder: group.sortOrder,
      items: items.map((item: any) => ({
        id: item.id,
        medicineId: item.medicineId,
        medicineName: item.medicineName,
        dose: item.dose,
        frequency: item.frequency,
        durationDays: item.durationDays,
        instructions: item.instructions,
        sortOrder: item.sortOrder,
      })),
    };
  });
}

/**
 * Creates an institutional or doctor-personal Rx-Group with medication items.
 */
export async function createRxGroup(args: CreateRxGroupInput): Promise<RxGroupView> {
  const trimmedName = args.name?.trim();
  if (!trimmedName || trimmedName.length < 2) {
    throw new RxGroupValidationError('Rx-Group name must be at least 2 characters');
  }

  if (!args.items || args.items.length === 0) {
    throw new RxGroupValidationError('Rx-Group must contain at least one medication item');
  }

  for (const item of args.items) {
    if (!item.medicineName?.trim() || !item.dose?.trim() || !item.frequency?.trim()) {
      throw new RxGroupValidationError('Each medication item must have a name, dose, and frequency');
    }
  }

  return withTenant(args.hospitalId, async (tx) => {
    const [insertedGroup] = await tx
      .insert(rxGroups)
      .values({
        hospitalId: args.hospitalId,
        branchId: args.branchId ?? null,
        doctorId: args.doctorId ?? null,
        name: trimmedName,
        description: args.description?.trim() ?? null,
        category: args.category?.trim() || 'general',
        defaultDiagnosis: args.defaultDiagnosis?.trim() ?? null,
        defaultAdvice: args.defaultAdvice?.trim() ?? null,
        defaultFollowUpDays: args.defaultFollowUpDays ?? null,
        sortOrder: 0,
        active: true,
      })
      .returning();

    const itemRows = args.items.map((item, index) => ({
      hospitalId: args.hospitalId,
      rxGroupId: insertedGroup.id,
      medicineId: item.medicineId,
      medicineName: item.medicineName.trim(),
      dose: item.dose.trim(),
      frequency: item.frequency.trim(),
      durationDays: item.durationDays ?? null,
      instructions: item.instructions?.trim() ?? null,
      sortOrder: item.sortOrder ?? index,
    }));

    const insertedItems = await tx
      .insert(rxGroupItems)
      .values(itemRows)
      .returning();

    return {
      id: insertedGroup.id,
      name: insertedGroup.name,
      description: insertedGroup.description,
      category: insertedGroup.category,
      doctorId: insertedGroup.doctorId,
      isPersonal: Boolean(insertedGroup.doctorId),
      defaultDiagnosis: insertedGroup.defaultDiagnosis,
      defaultAdvice: insertedGroup.defaultAdvice,
      defaultFollowUpDays: insertedGroup.defaultFollowUpDays,
      sortOrder: insertedGroup.sortOrder,
      items: insertedItems.map((item: any) => ({
        id: item.id,
        medicineId: item.medicineId,
        medicineName: item.medicineName,
        dose: item.dose,
        frequency: item.frequency,
        durationDays: item.durationDays,
        instructions: item.instructions,
        sortOrder: item.sortOrder,
      })),
    };
  });
}

/**
 * Deactivates or removes an Rx-Group. If actorDoctorId is given, ensures the doctor owns the group.
 */
export async function deleteRxGroup(args: {
  hospitalId: string;
  rxGroupId: string;
  actorDoctorId?: string | null;
}): Promise<void> {
  return withTenant(args.hospitalId, async (tx) => {
    const conditions = [
      eq(rxGroups.hospitalId, args.hospitalId),
      eq(rxGroups.id, args.rxGroupId),
    ];
    if (args.actorDoctorId) {
      conditions.push(or(isNull(rxGroups.doctorId), eq(rxGroups.doctorId, args.actorDoctorId))!);
    }

    await tx
      .update(rxGroups)
      .set({ active: false, updatedAt: new Date() })
      .where(and(...conditions));
  });
}

/**
 * Standard clinical defaults seeded when a hospital has no templates.
 */
export const DEFAULT_CLINICAL_BUNDLES = [
  {
    name: 'Upper Respiratory Infection (URI) Pack',
    description: 'Standard 5-day regimen for acute bacterial upper respiratory tract infection',
    category: 'respiratory',
    defaultDiagnosis: 'Acute Upper Respiratory Tract Infection',
    defaultAdvice: 'Plenty of warm fluids, steam inhalation twice daily, adequate rest',
    defaultFollowUpDays: 5,
    medicines: [
      { name: 'Amoxicillin 500mg', dose: '1 tablet', frequency: '1-0-1', durationDays: 5, instructions: 'After food' },
      { name: 'Paracetamol 650mg', dose: '1 tablet', frequency: 'SOS', durationDays: 5, instructions: 'After food if fever > 100 F' },
      { name: 'Cetirizine 10mg', dose: '1 tablet', frequency: '0-0-1', durationDays: 5, instructions: 'At bedtime' },
      { name: 'Pantoprazole 40mg', dose: '1 tablet', frequency: '1-0-0', durationDays: 5, instructions: 'Empty stomach / before breakfast' },
    ],
  },
  {
    name: 'Acute Gastroenteritis Pack',
    description: '3-day symptomatic and antibiotic rehydration protocol',
    category: 'gastroenterology',
    defaultDiagnosis: 'Acute Gastroenteritis',
    defaultAdvice: 'Drink plenty of fluids with ORS and coconut water. Avoid spicy, oily, or unpasteurized food.',
    defaultFollowUpDays: 3,
    medicines: [
      { name: 'Ciprofloxacin 500mg', dose: '1 tablet', frequency: '1-0-1', durationDays: 3, instructions: 'After food' },
      { name: 'Ondansetron 4mg', dose: '1 tablet', frequency: '1-0-1', durationDays: 3, instructions: 'Before food' },
      { name: 'ORS Sachet', dose: '1 sachet in 1L water', frequency: 'SOS', durationDays: 3, instructions: 'Drink sip by sip' },
      { name: 'Zinc Sulfate 20mg', dose: '1 tablet', frequency: '1-0-0', durationDays: 14, instructions: 'After food' },
    ],
  },
  {
    name: 'Stage-1 Hypertension Protocol',
    description: 'First-line monotherapy or dual anti-hypertensive regimen',
    category: 'cardiology',
    defaultDiagnosis: 'Essential Hypertension (Stage-1)',
    defaultAdvice: 'Low salt diet (< 5g/day), brisk walking 30 min daily, maintain blood pressure diary',
    defaultFollowUpDays: 30,
    medicines: [
      { name: 'Telmisartan 40mg', dose: '1 tablet', frequency: '1-0-0', durationDays: 30, instructions: 'Morning after breakfast' },
      { name: 'Amlodipine 5mg', dose: '1 tablet', frequency: '0-0-1', durationDays: 30, instructions: 'At bedtime' },
    ],
  },
  {
    name: 'Type-2 Diabetes Starter',
    description: 'Initial oral glycemic management protocol',
    category: 'diabetology',
    defaultDiagnosis: 'Type-2 Diabetes Mellitus',
    defaultAdvice: 'Diabetic diet plan, avoid refined sugars, weekly fasting and postprandial sugar monitoring',
    defaultFollowUpDays: 30,
    medicines: [
      { name: 'Metformin 500mg SR', dose: '1 tablet', frequency: '1-0-1', durationDays: 30, instructions: 'With meals' },
      { name: 'Glimepiride 1mg', dose: '1 tablet', frequency: '1-0-0', durationDays: 30, instructions: 'Before breakfast' },
    ],
  },
  {
    name: 'Pediatric Fever & Pain Pack',
    description: 'Safe antipyretic suspension regimen for pediatric patients',
    category: 'pediatrics',
    defaultDiagnosis: 'Acute Febrile Illness',
    defaultAdvice: 'Tepid sponging if temperature exceeds 101 F. Offer plenty of oral fluids and breast milk.',
    defaultFollowUpDays: 3,
    medicines: [
      { name: 'Paracetamol 250mg/5ml Syrup', dose: '5 ml', frequency: 'SOS', durationDays: 3, instructions: 'After feeds (max 4 times daily)' },
      { name: 'Cetirizine 5mg/5ml Syrup', dose: '2.5 ml', frequency: '0-0-1', durationDays: 3, instructions: 'At night before sleep' },
    ],
  },
];

/**
 * Seeds default institutional clinical bundles for a hospital if none exist.
 */
export async function seedDefaultRxGroups(args: { hospitalId: string }): Promise<number> {
  return withTenant(args.hospitalId, async (tx) => {
    // 1. Check if any groups already exist
    const [existing] = await tx
      .select({ id: rxGroups.id })
      .from(rxGroups)
      .where(and(eq(rxGroups.hospitalId, args.hospitalId), eq(rxGroups.active, true)))
      .limit(1);

    if (existing) {
      return 0; // Already seeded
    }

    // 2. Fetch existing medicines to link
    const existingMeds = await tx
      .select({ id: medicines.id, name: medicines.name })
      .from(medicines)
      .where(eq(medicines.hospitalId, args.hospitalId));

    const medNameMap = new Map<string, string>();
    for (const m of existingMeds) {
      medNameMap.set(m.name.toLowerCase().trim(), m.id);
    }

    let seededCount = 0;

    for (const [bundleIndex, bundle] of DEFAULT_CLINICAL_BUNDLES.entries()) {
      const itemsToInsert: CreateRxGroupItemInput[] = [];

      for (const [itemIndex, m] of bundle.medicines.entries()) {
        let medicineId = medNameMap.get(m.name.toLowerCase().trim());

        // If medicine doesn't exist in hospital catalog, create it
        if (!medicineId) {
          const [newMed] = await tx
            .insert(medicines)
            .values({
              hospitalId: args.hospitalId,
              name: m.name,
              unit: 'unit',
              active: true,
            })
            .returning();
          medicineId = newMed.id;
          medNameMap.set(m.name.toLowerCase().trim(), medicineId);
        }

        itemsToInsert.push({
          medicineId,
          medicineName: m.name,
          dose: m.dose,
          frequency: m.frequency,
          durationDays: m.durationDays,
          instructions: m.instructions,
          sortOrder: itemIndex,
        });
      }

      const [group] = await tx
        .insert(rxGroups)
        .values({
          hospitalId: args.hospitalId,
          name: bundle.name,
          description: bundle.description,
          category: bundle.category,
          defaultDiagnosis: bundle.defaultDiagnosis,
          defaultAdvice: bundle.defaultAdvice,
          defaultFollowUpDays: bundle.defaultFollowUpDays,
          sortOrder: bundleIndex,
          active: true,
        })
        .returning();

      await tx.insert(rxGroupItems).values(
        itemsToInsert.map((item) => ({
          hospitalId: args.hospitalId,
          rxGroupId: group.id,
          medicineId: item.medicineId,
          medicineName: item.medicineName,
          dose: item.dose,
          frequency: item.frequency,
          durationDays: item.durationDays ?? null,
          instructions: item.instructions ?? null,
          sortOrder: item.sortOrder ?? 0,
        })),
      );

      seededCount++;
    }

    return seededCount;
  });
}
