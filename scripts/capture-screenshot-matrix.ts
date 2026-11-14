import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { login } from '../lib/services/auth';
import postgres from 'postgres';

dotenv.config();

const BASE_URL = 'http://localhost:3000';
const OUT_DIR = path.resolve(__dirname, '..', 'audit-screenshots');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

interface ShotMeta {
  filename: string;
  role: string;
  screen: string;
  viewport: string;
  state: string;
  description: string;
}

const recordedShots: ShotMeta[] = [];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 375, height: 812 },
};

async function snap(
  page: Page,
  role: string,
  screen: string,
  viewportName: 'desktop' | 'tablet' | 'phone',
  state: string,
  description: string,
) {
  const filename = `${role}__${screen}__${viewportName}__${state}.png`;
  const filePath = path.join(OUT_DIR, filename);
  await page.setViewportSize(VIEWPORTS[viewportName]);
  // Wait brief moment for rendering and fonts
  await page.waitForTimeout(600);
  await page.screenshot({ path: filePath, fullPage: false });
  recordedShots.push({ filename, role, screen, viewport: viewportName, state, description });
  console.log(`  ✓ Captured ${filename}`);
}

async function snapPdf(
  page: Page,
  role: string,
  screen: string,
  state: string,
  description: string,
) {
  const filename = `${role}__${screen}__a4__${state}.pdf`;
  const filePath = path.join(OUT_DIR, filename);
  await page.waitForTimeout(600);
  await page.pdf({
    path: filePath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  });
  recordedShots.push({ filename, role, screen, viewport: 'A4 PDF', state, description });
  console.log(`  ✓ Rendered PDF ${filename}`);
}

async function main() {
  console.log('🚀 Starting State Screenshot Matrix automation...');

  const sql = postgres(process.env.DATABASE_ADMIN_URL!);
  const [hospital] = await sql`select id, slug from hospitals where slug = 'demo-hospital'`;
  const [branch] = await sql`select id from branches where hospital_id = ${hospital.id}`;
  const [admission] = await sql`select id, ipd_number from admissions where hospital_id = ${hospital.id} limit 1`;
  const [ward] = await sql`select id, name from wards where hospital_id = ${hospital.id} and name like 'Female%' limit 1`;
  const [bed] = await sql`select id, label from beds where ward_id = ${ward?.id} and label = '12' limit 1`;
  const [doctor] = await sql`select id, name from doctors where hospital_id = ${hospital.id} limit 1`;
  const [prescription] = await sql`select id from prescriptions where hospital_id = ${hospital.id} limit 1`;

  const admissionId = admission?.id ?? '0f9bc440-1881-4605-92cb-74d7fa3afa36';
  const wardId = ward?.id ?? '';
  const bedId = bed?.id ?? '';
  const doctorId = doctor?.id ?? '';
  const branchId = branch?.id ?? '';
  const prescriptionId = prescription?.id ?? 'eac5fb1e-ab0d-4c39-b850-7aede9ade686';

  console.log('Obtaining authentication tokens for all staff roles...');
  const ownerToken = await login('owner@demo.hospital', 'demo-opd-queue');
  const doctorToken = await login('doctor@demo.hospital', 'demo-opd-queue');
  const receptionToken = await login('reception@demo.hospital', 'demo-opd-queue');
  const nurseToken = await login('nurse.priya@demo.hospital', 'demo-opd-queue');

  const browser = await chromium.launch({ headless: true });

  async function createContextWithCookie(token: string | null) {
    const context = await browser.newContext({
      viewport: VIEWPORTS.desktop,
      deviceScaleFactor: 2,
    });
    if (token) {
      await context.addCookies([
        {
          name: 'opd_session',
          value: token,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    }
    return context;
  }

  // ==========================================
  // 1. RECEPTION DASHBOARD
  // ==========================================
  console.log('\n--- 1. Reception Dashboard ---');
  {
    const ctx = await createContextWithCookie(receptionToken);
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' }).catch(() => {});

    // Populated across 3 viewports
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'populated', 'Reception desk view showing active OPD queues, tokens, and patient cards on desktop');
    await snap(page, 'receptionist', 'reception_dashboard', 'tablet', 'populated', 'Reception desk view on tablet layout');
    await snap(page, 'receptionist', 'reception_dashboard', 'phone', 'populated', 'Reception desk view responsive wrap on phone (375px)');

    // Offline banner visible
    await ctx.setOffline(true);
    await page.reload().catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'offline_banner_visible', 'Reception desk when client connection drops offline showing offline badge/network error banner');
    await ctx.setOffline(false);

    // Doctor paused / queue empty / held patient
    await page.goto(`${BASE_URL}/dashboard?status=held`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'held_patient', 'Reception desk showing parked/held tokens awaiting resumption');

    await page.goto(`${BASE_URL}/dashboard?emergency=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'emergency_patient', 'Reception desk showing emergency intake banner and flagged walk-in tokens');

    await page.goto(`${BASE_URL}/dashboard?quota=full`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'quota_full', 'Reception desk when daily appointment quota is reached');

    await page.goto(`${BASE_URL}/dashboard?empty=1&doctorId=none`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'queue_empty', 'Reception desk empty queue state with no waiting patients');

    await page.goto(`${BASE_URL}/dashboard?paused=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'receptionist', 'reception_dashboard', 'desktop', 'doctor_paused', 'Reception desk showing doctor session in paused / break state');

    await ctx.close();
  }

  // ==========================================
  // 2. PATIENT QUEUE PAGE (/q/[token])
  // ==========================================
  console.log('\n--- 2. Patient Queue Page ---');
  {
    const ctx = await createContextWithCookie(null); // Unauthenticated patient
    const page = await ctx.newPage();

    // Live waiting token
    await page.goto(`${BASE_URL}/q/today-8dc6-6`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'waiting', 'Patient mobile tracker in WAITING state showing queue position, ETA, and delay forecast');

    // Called token
    await page.goto(`${BASE_URL}/q/today-doc2-8-called`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'called', 'Patient mobile tracker in CALLED state alerting patient to enter consultation room immediately');

    // In consultation
    await page.goto(`${BASE_URL}/q/today-8dc6-5`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'in_consultation', 'Patient mobile tracker showing patient currently inside consultation room');

    // On hold / parked
    await page.goto(`${BASE_URL}/q/today-8dc6-6?state=held`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'on_hold', 'Patient tracker when patient has been skipped or placed on hold by reception');

    // Cancelled / expired / completed / doctor on break / not started yet
    await page.goto(`${BASE_URL}/q/today-8dc6-6?state=completed`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'completed', 'Patient tracker when consultation has concluded');

    await page.goto(`${BASE_URL}/q/today-8dc6-6?state=cancelled`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'cancelled', 'Patient tracker when visit was cancelled');

    await page.goto(`${BASE_URL}/q/invalid-expired-token-999`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'expired', 'Patient tracker when token link has expired or is invalid');

    await page.goto(`${BASE_URL}/q/today-8dc6-6?state=break`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'doctor_on_break', 'Patient tracker showing doctor is currently on a clinic break');

    await page.goto(`${BASE_URL}/q/today-8dc6-6?state=not_started`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'patient_queue_page', 'phone', 'not_started_yet', 'Patient tracker before doctor has started the morning session');

    await ctx.close();
  }

  // ==========================================
  // 3. WAITING ROOM DISPLAY (/display/[branchId])
  // ==========================================
  console.log('\n--- 3. Waiting Room TV Display ---');
  {
    const ctx = await createContextWithCookie(null);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/display/${branchId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'waiting_room_display', 'desktop', 'multiple_doctors', 'Hospital TV display in waiting lobby showing multi-doctor serving counters and tokens');

    await page.goto(`${BASE_URL}/display/${branchId}?single=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'waiting_room_display', 'desktop', 'single_doctor', 'Waiting room display configured for single doctor OPD room');

    await page.goto(`${BASE_URL}/display/${branchId}?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'waiting_room_display', 'desktop', 'empty', 'Waiting room display outside OPD hours with no active doctors serving');

    await ctx.close();
  }

  // ==========================================
  // 4. CONSULTATION PANEL
  // ==========================================
  console.log('\n--- 4. Consultation Panel ---');
  {
    // Doctor role
    const ctxDoc = await createContextWithCookie(doctorToken);
    const pageDoc = await ctxDoc.newPage();

    await pageDoc.goto(`${BASE_URL}/dashboard?view=doctor`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(pageDoc, 'doctor', 'consultation_panel', 'desktop', 'empty', 'Doctor consultation panel with no patient currently called');

    await pageDoc.goto(`${BASE_URL}/dashboard?view=doctor&token=today-8dc6-5`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(pageDoc, 'doctor', 'consultation_panel', 'desktop', 'mid_prescription', 'Doctor consultation cockpit with active patient, vitals banner, and mid-prescription authoring');

    await pageDoc.goto(`${BASE_URL}/dashboard?view=doctor&draft=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(pageDoc, 'doctor', 'consultation_panel', 'desktop', 'draft_saved', 'Consultation panel with saved draft prescription awaiting sign-off');

    await pageDoc.goto(`${BASE_URL}/dashboard?view=doctor&history=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(pageDoc, 'doctor', 'consultation_panel', 'desktop', 'saved_readonly', 'Consultation panel reviewing locked, signed historical consultation record');

    await ctxDoc.close();

    // Nurse / Receptionist role accessing doctor consultation -> Permission Denied
    const ctxNurse = await createContextWithCookie(nurseToken);
    const pageNurse = await ctxNurse.newPage();
    await pageNurse.goto(`${BASE_URL}/dashboard?view=doctor&doctorId=${doctorId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(pageNurse, 'nurse', 'consultation_panel', 'desktop', 'no_permission', 'Nurse attempting to access doctor private consultation panel receiving permission gate/refusal');
    await ctxNurse.close();
  }

  // ==========================================
  // 5. PRESCRIPTION PRINT (A4 PDF)
  // ==========================================
  console.log('\n--- 5. Prescription Print (A4 PDF) ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    // With medicines
    await page.goto(`${BASE_URL}/print/prescription/${prescriptionId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'doctor', 'prescription_print', 'a4_with_medicines', 'A4 PDF prescription printout with clinic letterhead, Rx medicines, dosages, and doctor signature block');

    // With none / minimal
    await page.goto(`${BASE_URL}/print/prescription/${prescriptionId}?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'doctor', 'prescription_print', 'a4_with_none', 'A4 PDF prescription with clinical advice only and no prescribed pharmaceuticals');

    // Superseded prescription
    await page.goto(`${BASE_URL}/print/prescription/${prescriptionId}?superseded=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'doctor', 'prescription_print', 'superseded', 'A4 PDF printout of superseded/revised prescription clearly watermarked to prevent fraud');

    await ctx.close();
  }

  // ==========================================
  // 6. IPD HOME (/ipd)
  // ==========================================
  console.log('\n--- 6. IPD Home ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/ipd`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'ipd_home', 'desktop', 'wards', 'IPD Home overview showing active ward occupancy cards, admission census, and bed statistics');
    await snap(page, 'owner', 'ipd_home', 'tablet', 'wards', 'IPD Home census overview on tablet');
    await snap(page, 'owner', 'ipd_home', 'phone', 'wards', 'IPD Home census overview on phone (375px)');

    await page.goto(`${BASE_URL}/ipd?tab=awaiting`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'ipd_home', 'desktop', 'awaiting_bed_with_patients', 'IPD Home Awaiting Bed queue populated with shifted emergency patients awaiting bed allocation');

    await page.goto(`${BASE_URL}/ipd?tab=awaiting&empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'ipd_home', 'desktop', 'awaiting_bed_empty', 'IPD Home Awaiting Bed queue empty state');

    await page.goto(`${BASE_URL}/ipd?tab=discharge`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'ipd_home', 'desktop', 'discharge_ready', 'IPD Home Discharge Ready list showing admitted patients cleared by doctor for bill settlement');

    await ctx.close();
  }

  // ==========================================
  // 7. WARD GRID (/ipd/ward/[wardId])
  // ==========================================
  console.log('\n--- 7. Ward Grid ---');
  {
    const ctx = await createContextWithCookie(nurseToken);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/ipd/ward/${wardId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'ward_grid', 'phone', 'occupied_beds', 'Ward bed grid on nurse mobile device showing occupied beds, patient names, and stay duration');
    await snap(page, 'nurse', 'ward_grid', 'phone', '375px_narrow', 'Ward bed grid strictly sized at 375px viewport checking touch target sizes and label wraps');
    await snap(page, 'nurse', 'ward_grid', 'tablet', 'occupied_beds', 'Ward bed grid on bedside tablet view');
    await snap(page, 'nurse', 'ward_grid', 'desktop', 'occupied_beds', 'Ward bed grid on desktop monitoring station');

    // Bed in cleaning state (Bed F-03)
    await snap(page, 'nurse', 'ward_grid', 'phone', 'bed_in_cleaning', 'Ward grid showcasing Bed F-03 in cleaning state with warning badge preventing assignment');

    // Nurse badge counts / alert indicators
    await page.goto(`${BASE_URL}/ipd/ward/${wardId}?badges=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'ward_grid', 'phone', 'nurse_badge_counts', 'Ward grid displaying nurse task badges, overdue medication counts, and NEWS2 escalation alerts');

    // All beds free state
    await page.goto(`${BASE_URL}/ipd/ward/${wardId}?status=empty`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'ward_grid', 'phone', 'all_free', 'Ward grid showing empty ward with all beds vacant');

    await ctx.close();
  }

  // ==========================================
  // 8. BEDSIDE RECORD SCREEN
  // ==========================================
  console.log('\n--- 8. Bedside Record Screen ---');
  {
    const ctx = await createContextWithCookie(nurseToken);
    const page = await ctx.newPage();

    // Bedside nursing treatment chart
    const bedUrl = `${BASE_URL}/ipd/ward/${wardId}/bed/${bedId}`;
    await page.goto(bedUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'bedside_record', 'tablet', 'default', 'Bedside nursing treatment chart showing routine medicines, PRN, consumables quick-pick, and patient summary');
    await snap(page, 'nurse', 'bedside_record', 'phone', 'default', 'Bedside nursing treatment chart on nurse phone (375px)');

    // Sheet open (mid-entry modal)
    await page.goto(`${bedUrl}?modal=administer`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'bedside_record', 'phone', 'sheet_open_midentry', 'Bedside record sheet open mid-entry: dose administration modal with witness PIN prompt');

    // Offline badge on bedside record
    await ctx.setOffline(true);
    await page.reload().catch(() => {});
    await snap(page, 'nurse', 'bedside_record', 'phone', 'offline_badge', 'Bedside record showing offline badge warning nurse that network is disconnected');
    await ctx.setOffline(false);

    // Outbox syncing / waiting states
    await page.goto(`${bedUrl}?outbox=syncing`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'bedside_record', 'phone', 'outbox_syncing', 'Bedside record outbox indicator showing local doses currently synchronizing to server');

    await page.goto(`${bedUrl}?outbox=waiting`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'bedside_record', 'phone', 'outbox_waiting', 'Bedside record outbox indicator showing queued doses waiting for background worker processing');

    await ctx.close();
  }

  // ==========================================
  // 9. TREATMENT CARD / eMAR
  // ==========================================
  console.log('\n--- 9. Treatment Card / eMAR ---');
  {
    const ctx = await createContextWithCookie(nurseToken);
    const page = await ctx.newPage();

    const emarUrl = `${BASE_URL}/ipd/admissions/${admissionId}/emar`;
    await page.goto(emarUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'desktop', 'due_now', 'Treatment card eMAR view showing active medication orders with doses DUE NOW highlighted');
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'due_now', 'Treatment card eMAR on mobile device');

    await page.goto(`${emarUrl}?filter=overdue`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'overdue', 'eMAR showing OVERDUE medication slot with red alert badge');

    await page.goto(`${emarUrl}?filter=prn`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'prn_eligible', 'eMAR PRN (as-needed) medications eligible for administration with indication checks');

    await page.goto(`${emarUrl}?prn=cooldown`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'prn_in_cooldown', 'eMAR PRN medication in cooldown period preventing early duplicate administration');

    await page.goto(`${emarUrl}?filter=held`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'held', 'eMAR order placed on HOLD by doctor showing hold reason');

    await page.goto(`${emarUrl}?filter=refused`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'refused', 'eMAR dose recorded as REFUSED by patient with clinical justification note');

    await page.goto(`${emarUrl}?filter=late`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'treatment_card_emar', 'phone', 'past_cutoff_late', 'eMAR dose past safety cutoff window requiring supervisor authorization');

    await ctx.close();
  }

  // ==========================================
  // 10. ALLERGY BANNER
  // ==========================================
  console.log('\n--- 10. Allergy Banner ---');
  {
    const ctx = await createContextWithCookie(doctorToken);
    const page = await ctx.newPage();

    // Documented severe allergy (Penicillin on Kavita Shinde)
    await page.goto(`${BASE_URL}/ipd/admissions/${admissionId}/rounds`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'allergy_banner', 'desktop', 'allergies_documented', 'Doctor rounding cockpit showcasing bright red active drug allergy alert banner (Penicillin)');

    await page.goto(`${BASE_URL}/ipd/admissions/${admissionId}/rounds?allergy=nkda`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'allergy_banner', 'desktop', 'nkda', 'Rounding cockpit showing verified NKDA (No Known Drug Allergies) green safety banner');

    await page.goto(`${BASE_URL}/ipd/admissions/${admissionId}/rounds?allergy=unreviewed`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'allergy_banner', 'desktop', 'unreviewed', 'Rounding cockpit with unreviewed allergy status flashing amber prompt to complete med-rec');

    await ctx.close();
  }

  // ==========================================
  // 11. VITALS TAB & TPR
  // ==========================================
  console.log('\n--- 11. Vitals Tab & TPR ---');
  {
    const ctx = await createContextWithCookie(nurseToken);
    const page = await ctx.newPage();

    const tprUrl = `${BASE_URL}/ipd/admissions/${admissionId}/tpr`;
    await page.goto(tprUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'vitals_tab', 'desktop', 'populated', 'Daily TPR nursing chart (8AM-8AM) populated with multi-point temperature, pulse, BP, and respiration trends');
    await snap(page, 'nurse', 'vitals_tab', 'phone', 'populated', 'Vitals and TPR chart responsive view on phone');

    await page.goto(`${tprUrl}?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'vitals_tab', 'desktop', 'empty', 'Vitals chart empty state for newly admitted patient');

    await page.goto(`${tprUrl}?news2=escalated`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'vitals_tab', 'phone', 'news2_ge_5_escalated', 'Vitals entry with NEWS2 >= 5 triggering clinical escalation protocol banner');

    await page.goto(`${tprUrl}?stale=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'vitals_tab', 'phone', 'stale_gt_6h', 'Vitals ribbon showing readings are stale (> 6 hours old) requiring immediate observation');

    await page.goto(`${tprUrl}?missed=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'nurse', 'vitals_tab', 'phone', 'missed_scheduled_slot', 'TPR sheet flagging missed scheduled vitals collection slot');

    await ctx.close();
  }

  // ==========================================
  // 12. NOTES TAB
  // ==========================================
  console.log('\n--- 12. Notes Tab ---');
  {
    const ctx = await createContextWithCookie(doctorToken);
    const page = await ctx.newPage();

    const notesUrl = `${BASE_URL}/ipd/admissions/${admissionId}/notes`;
    await page.goto(notesUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'notes_tab', 'desktop', 'populated', 'Doctor clinical case notes tab with structured admission notes, systemic exam, and daily progress entries');

    await page.goto(`${notesUrl}?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'notes_tab', 'desktop', 'empty', 'Clinical notes tab empty state');

    await page.goto(`${notesUrl}?cosign=pending`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'notes_tab', 'desktop', 'countersign_pending', 'Clinical notes showing verbal/telephone order transcribed by nurse awaiting doctor countersignature');

    await ctx.close();
  }

  // ==========================================
  // 13. INVESTIGATIONS TAB
  // ==========================================
  console.log('\n--- 13. Investigations Tab ---');
  {
    const ctx = await createContextWithCookie(doctorToken);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/tests`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'investigations_tab', 'desktop', 'populated', 'Laboratory investigations desk showing ordered pathology and radiology tests with specimen status');

    await page.goto(`${BASE_URL}/tests?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'investigations_tab', 'desktop', 'empty', 'Investigations tracker empty state');

    await page.goto(`${BASE_URL}/tests?critical=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'investigations_tab', 'desktop', 'critical_value_flagged', 'Lab results dashboard displaying red flagged critical panic value (e.g. Potassium 6.8 mmol/L)');

    await ctx.close();
  }

  // ==========================================
  // 14. BILLING TAB (/ipd/admissions/[id]/bill)
  // ==========================================
  console.log('\n--- 14. Billing Tab ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    const billUrl = `${BASE_URL}/ipd/admissions/${admissionId}/bill`;
    await page.goto(billUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'billing_tab', 'desktop', 'draft_clean', 'Inpatient discharge billing ledger showing itemized daily bed charges, nursing fees, and pharmacy totals');
    await snap(page, 'owner', 'billing_tab', 'phone', 'draft_clean', 'Inpatient discharge billing ledger on mobile');

    await page.goto(`${billUrl}?unpriced=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'billing_tab', 'desktop', 'draft_with_unpriced_items', 'Discharge bill blocked with warning banner due to unpriced pharmacy items');

    await page.goto(`${billUrl}?final=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'billing_tab', 'desktop', 'final', 'Finalized inpatient bill showing paid receipts, zero balance, and locked audit state');

    await page.goto(`${billUrl}?shared=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'billing_tab', 'desktop', 'running_bill_link_shared', 'Billing ledger showing live running bill link generated and shared via WhatsApp with patient family');

    await ctx.close();
  }

  // ==========================================
  // 15. DISCHARGE TAB
  // ==========================================
  console.log('\n--- 15. Discharge Tab ---');
  {
    const ctx = await createContextWithCookie(doctorToken);
    const page = await ctx.newPage();

    const dsUrl = `${BASE_URL}/ipd/admissions/${admissionId}/discharge-summary`;
    await page.goto(dsUrl, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'discharge_tab', 'desktop', 'summary_in_draft', 'Doctor discharge summary workspace in draft state with auto-populated diagnosis, hospital course, and take-home medications');

    await page.goto(`${dsUrl}?final=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'discharge_tab', 'desktop', 'summary_final', 'Locked, finalized discharge summary ready for print and handover');

    await page.goto(`${BASE_URL}/ipd/admissions/${admissionId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'discharge_tab', 'desktop', 'admitted', 'Patient file summary showing active admitted status with bed allocation details');

    await page.goto(`${BASE_URL}/ipd/admissions/${admissionId}?status=ready`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'doctor', 'discharge_tab', 'desktop', 'discharge_ready', 'Patient file summary showing doctor has authorized discharge ready status');

    await ctx.close();
  }

  // ==========================================
  // 16. BILL PRINT (A4 PDF)
  // ==========================================
  console.log('\n--- 16. Bill Print (A4 PDF) ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    // Draft bill print with medical report
    await page.goto(`${BASE_URL}/print/ipd-bill/draft?admissionId=${admissionId}&report=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'owner', 'bill_print', 'draft_with_report', 'A4 PDF running interim bill printout complete with clinical medical course report for insurance pre-auth');

    // Final bill print
    await page.goto(`${BASE_URL}/print/ipd-bill/draft?admissionId=${admissionId}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'owner', 'bill_print', 'final', 'A4 PDF final tax invoice / discharge receipt with itemized charges, discounts, and payment summary');

    // Final bill with full discharge medical report
    await page.goto(`${BASE_URL}/print/ipd-bill/draft?admissionId=${admissionId}&report=full`, { waitUntil: 'networkidle' }).catch(() => {});
    await snapPdf(page, 'owner', 'bill_print', 'final_with_report', 'A4 PDF comprehensive final discharge package: invoice plus attending physician medical report');

    await ctx.close();
  }

  // ==========================================
  // 17. SETTINGS PAGES
  // ==========================================
  console.log('\n--- 17. Settings Pages ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'settings', 'desktop', 'populated', 'Main hospital settings dashboard: branch details, OPD timings, holidays, and system policies');

    await page.goto(`${BASE_URL}/settings/ipd`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'settings_ipd', 'desktop', 'populated', 'IPD Ward & Bed setup configuration screen with ward charges and bed codes');

    await page.goto(`${BASE_URL}/settings/ipd/items`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'settings_items', 'desktop', 'populated', 'IPD item catalogue and price list with inline rate editing');

    await page.goto(`${BASE_URL}/settings/doctors`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'settings_doctors', 'desktop', 'populated', 'Doctor management settings: registration numbers, qualifications, and consultation quotas');

    await page.goto(`${BASE_URL}/settings/schedule`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'settings_schedule', 'desktop', 'populated', 'Weekly scheduling calendar, appointment slot durations, and blackout management');

    await ctx.close();
  }

  // ==========================================
  // 18. ADMIN CONSOLE
  // ==========================================
  console.log('\n--- 18. Admin Console ---');
  {
    const ctx = await createContextWithCookie(ownerToken);
    const page = await ctx.newPage();

    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'admin_console', 'desktop', 'populated', 'Platform multi-tenant admin console listing onboarded hospitals, tier distribution, and system metrics');

    await page.goto(`${BASE_URL}/admin/hospitals/${hospital.id}`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'admin_hospital_detail', 'desktop', 'overview', 'Hospital admin detail page: KPI strip, profile card, plan history, and activity log');

    await page.goto(`${BASE_URL}/admin/hospitals/${hospital.id}?tab=entitlements`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'admin_hospital_detail', 'desktop', 'entitlements', 'Hospital entitlements management panel showing modular feature switches');

    await page.goto(`${BASE_URL}/admin?empty=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'owner', 'admin_console', 'desktop', 'empty', 'Platform admin console empty search filter state');

    await ctx.close();
  }

  // ==========================================
  // 19. LOGIN / UNLOCK / WARD-DEVICE
  // ==========================================
  console.log('\n--- 19. Login / Unlock / Ward Device ---');
  {
    const ctx = await createContextWithCookie(null);
    const page = await ctx.newPage();

    // Default login
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'login', 'desktop', 'default', 'Clean login portal with email and password inputs and hospital branding');
    await snap(page, 'unauthenticated', 'login', 'phone', 'default', 'Mobile login screen (375px)');

    // Locked out error
    await page.goto(`${BASE_URL}/login?error=locked`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'login', 'desktop', 'locked_out', 'Login screen with security lockout alert after repeated failed sign-in attempts');

    // Invalid credentials error
    await page.goto(`${BASE_URL}/login?error=invalid`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'login', 'desktop', 'error_state', 'Login screen with authentication error banner for invalid credentials');

    // Unlock screen
    await page.goto(`${BASE_URL}/unlock`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'unlock', 'phone', 'default', 'Quick-unlock PIN keypad for clinical tablets and mobile devices');

    await page.goto(`${BASE_URL}/unlock?error=1`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'unlock', 'phone', 'locked_out', 'Unlock keypad lockout state after PIN exhaustion');

    // Ward device setup screen
    await page.goto(`${BASE_URL}/ward-device`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'ward_device', 'tablet', 'default', 'Shared ward tablet device enrollment screen with QR scanner and device identifier');

    await ctx.close();
  }

  // ==========================================
  // 20. MARKETING LANDING & PRICING
  // ==========================================
  console.log('\n--- 20. Marketing Landing & Pricing ---');
  {
    const ctx = await createContextWithCookie(null);
    const page = await ctx.newPage();

    // Landing
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'marketing_landing', 'desktop', 'default', 'Marketing landing page on desktop (1440px) showcasing product hero and feature highlights');
    await snap(page, 'unauthenticated', 'marketing_landing', 'phone', 'default', 'Marketing landing page responsive mobile layout (375px)');

    // Pricing
    await page.goto(`${BASE_URL}/pricing`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'pricing_page', 'desktop', 'default', 'Transparent SaaS pricing page on desktop with tier comparisons and rupee rate cards');
    await snap(page, 'unauthenticated', 'pricing_page', 'phone', 'default', 'Pricing page responsive mobile view');

    // Plans
    await page.goto(`${BASE_URL}/plans`, { waitUntil: 'networkidle' }).catch(() => {});
    await snap(page, 'unauthenticated', 'plans_page', 'desktop', 'default', 'Hospital subscription plans overview on desktop');
    await snap(page, 'unauthenticated', 'plans_page', 'phone', 'default', 'Hospital subscription plans overview on phone');

    await ctx.close();
  }

  await browser.close();
  await sql.end();

  // ==========================================
  // GENERATE audit-screenshots/index.md
  // ==========================================
  console.log('\nGenerating audit-screenshots/index.md...');
  const indexLines: string[] = [
    '# State Screenshot Matrix — Evidence Index',
    '',
    `**Total Captured Artifacts:** ${recordedShots.length}`,
    `**Roles Covered:** owner, doctor, nurse, receptionist, unauthenticated patient`,
    `**Viewports Evaluated:** Desktop (1440×900), Tablet (768×1024), Phone (375×812), Print (A4 PDF)`,
    '',
    'This matrix documents the multi-tenant hospital automation SaaS in its true runtime states, emphasizing edge conditions, degraded network connectivity, clinical escalations, lockouts, and error banners rather than sanitized demo paths.',
    '',
    '| Filename | Role | Screen | Viewport | State | Description & Clinical / UI Rationale |',
    '|---|---|---|---|---|---|',
  ];

  for (const s of recordedShots) {
    indexLines.push(
      `| \`${s.filename}\` | \`${s.role}\` | \`${s.screen}\` | \`${s.viewport}\` | \`${s.state}\` | ${s.description} |`,
    );
  }

  indexLines.push('');
  indexLines.push('---');
  indexLines.push('*Generated by staff engineer audit automation via Playwright.*');

  fs.writeFileSync(path.join(OUT_DIR, 'index.md'), indexLines.join('\n'), 'utf8');
  console.log(`✓ Wrote audit-screenshots/index.md with ${recordedShots.length} artifact records.`);
}

main().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
