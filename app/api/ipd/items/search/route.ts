import { NextResponse } from 'next/server';
import { searchCareItems } from '@/lib/services/care-entries';
import { ipdCaller } from '../../session';

/**
 * The record screen's search: medicines and IPD items by name, at most 10.
 * Names and units only — there is no price in this response to hide.
 */
export async function GET(request: Request) {
  const caller = await ipdCaller('ipd.record');
  if ('response' in caller) return caller.response;
  const query = (new URL(request.url).searchParams.get('q') ?? '').slice(0, 60);
  const results = await searchCareItems({ hospitalId: caller.session.hospitalId, query });
  return NextResponse.json({ results });
}
