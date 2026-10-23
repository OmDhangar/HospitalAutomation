import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getAdminDb } from '@/lib/db/admin';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ hospitalId: string }> },
) {
  try {
    const session = await requireSession();
    const { hospitalId } = await ctx.params;

    if (!session.isPlatformAdmin && session.hospitalId !== hospitalId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') ?? '';

    const q = query.trim();
    if (!q || q.length < 2) {
      return NextResponse.json({ patients: [], results: [] });
    }

    const db = getAdminDb();
    const digits = q.replace(/\D/g, '');

    // Multi-faceted similarity match:
    // 1. Exact / prefix / substring ILIKE match
    // 2. Phone number substring (if digits provided)
    // 3. Trigram similarity / word_similarity (handles typos, reversed order, substrings)
    // 4. Double-Metaphone phonetic match (handles phonetic spellings like Pooja / Puja, Bhosle / Bhosale)
    const rows = await db.execute<{
      id: string;
      name: string;
      phone_e164: string;
      whatsapp_opt_in_at: Date | null;
      match_score: number;
    }>(sql`
      SELECT p.id,
             p.name,
             p.phone_e164,
             p.whatsapp_opt_in_at,
             (
               CASE
                 WHEN lower(p.name) = lower(${q}) THEN 100
                 WHEN p.name ILIKE ${q + '%'} THEN 85
                 WHEN p.name ILIKE ${'%' + q + '%'} THEN 75
                 WHEN ${digits.length >= 4} AND p.phone_e164 LIKE ${'%' + digits + '%'} THEN 70
                 WHEN EXISTS (
                   SELECT 1 
                     FROM unnest(string_to_array(lower(p.name), ' ')) w,
                          unnest(string_to_array(lower(${q}), ' ')) q_tok
                    WHERE dmetaphone(w) = dmetaphone(q_tok)
                 ) THEN 60 + (similarity(p.name, ${q}) * 20)
                 WHEN word_similarity(${q}, p.name) >= 0.3 THEN 50 + (word_similarity(${q}, p.name) * 20)
                 ELSE 30 + (similarity(p.name, ${q}) * 20)
               END
             )::float as match_score
        FROM patients p
       WHERE p.hospital_id = ${hospitalId}::uuid
         AND p.merged_into_id IS NULL
         AND (
           p.name ILIKE ${'%' + q + '%'}
           OR (${digits.length >= 3} AND p.phone_e164 LIKE ${'%' + digits + '%'})
           OR word_similarity(${q}, p.name) >= 0.30
           OR similarity(p.name, ${q}) >= 0.25
           OR EXISTS (
             SELECT 1 
               FROM unnest(string_to_array(lower(p.name), ' ')) w,
                    unnest(string_to_array(lower(${q}), ' ')) q_tok
              WHERE dmetaphone(w) = dmetaphone(q_tok)
           )
         )
       ORDER BY match_score DESC, p.updated_at DESC
       LIMIT 15
    `);

    const patients = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phoneE164: r.phone_e164,
      whatsappOptInAt: r.whatsapp_opt_in_at
        ? new Date(r.whatsapp_opt_in_at).toISOString()
        : null,
    }));

    return NextResponse.json({
      patients,
      results: patients,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    console.error('[api:patients:search]', error);
    return NextResponse.json({ error: 'Failed to search patients' }, { status: 500 });
  }
}
