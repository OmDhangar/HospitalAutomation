import { requirePlatformAdmin } from '@/lib/auth/platform';
import { AdminNav } from './nav';

/**
 * The console's chrome.
 *
 * The gate here is for the navigation, not for security — each page calls
 * `requirePlatformAdmin` itself, because a layout does not run in front of a
 * server action and is not a boundary anything can be trusted to.
 */
export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  await requirePlatformAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Platform console</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Every hospital on the platform, their plans and their usage.
        </p>
      </div>
      <AdminNav />
      {children}
    </div>
  );
}
