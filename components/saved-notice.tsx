import { Alert, Button, Input } from '@/components/ui';

/**
 * The "Saved" message every screen already shows after an action, with an
 * Undo beside it (decided 3 Oct 2026: everyone makes mistakes). Same place,
 * same look; one extra button. The token says what to take back; the server
 * re-checks everything before it does.
 *
 * `reasonPrompt` turns the button into a short form for the one undo that
 * needs a reason (reopening a final bill).
 */
export function SavedNotice({
  message,
  undo,
  action,
  hidden,
  reasonPrompt,
}: {
  message: string;
  undo?: string | null;
  action?: (form: FormData) => Promise<void>;
  hidden?: Record<string, string>;
  reasonPrompt?: string;
}) {
  return (
    <Alert tone="success">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>{message}</span>
        {undo && action ? (
          <form action={action} className="flex shrink-0 items-center gap-2">
            <input type="hidden" name="undo" value={undo} />
            {Object.entries(hidden ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            {reasonPrompt ? (
              <Input name="reason" required placeholder={reasonPrompt} className="h-9 w-48 bg-white py-1.5 text-sm" />
            ) : null}
            <Button type="submit" size="sm" variant="secondary" className="min-h-9 bg-white">
              {reasonPrompt ? 'Reopen' : 'Undo'}
            </Button>
          </form>
        ) : null}
      </div>
    </Alert>
  );
}
