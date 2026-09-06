import Link from 'next/link';
import { Suspense } from 'react';
import { Button } from '@/components/ui';
import { getSession } from '@/lib/auth/session';

/**
 * Async server component that reads the session cookie. Wrapped in Suspense
 * so the rest of the landing page can render instantly as static content
 * while this small piece streams in once the session is resolved.
 */
async function ResolvedAuthButton() {
  const session = await getSession();

  if (session) {
    return (
      <Link href="/dashboard">
        <Button variant="primary" size="sm">
          Go to Dashboard →
        </Button>
      </Link>
    );
  }

  return (
    <>
      <Link href="/login" className="text-xs font-semibold text-ink-700 hover:text-ink-900">
        Sign in
      </Link>
      <a href="#demo">
        <Button variant="primary" size="sm">
          Book Demo
        </Button>
      </a>
    </>
  );
}

/** Placeholder shown while the session is being resolved. */
function AuthButtonSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-8 w-28 animate-pulse rounded-lg bg-ink-200" />
    </div>
  );
}

/**
 * Self-contained auth button with built-in Suspense boundary.
 * Drop this into the landing page header — no `await` needed in the parent.
 */
export function AuthButton() {
  return (
    <div className="flex items-center gap-3">
      <Suspense fallback={<AuthButtonSkeleton />}>
        <ResolvedAuthButton />
      </Suspense>
    </div>
  );
}
