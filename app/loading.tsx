export default function RootLoading() {
  return (
    <div className="fixed inset-x-0 top-0 z-50 h-1 bg-brand-100 overflow-hidden">
      <div className="h-full bg-brand-600 animate-indeterminate" />
    </div>
  );
}
