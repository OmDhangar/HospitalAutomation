'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { cn } from '@/components/ui';

export type ToastType = 'success' | 'error' | 'info' | 'warn';

export type ToastMessage = {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
};

type ToastContextType = {
  toasts: ToastMessage[];
  showToast: (title: string, options?: { description?: string; type?: ToastType }) => void;
  removeToast: (id: string) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (title: string, options?: { description?: string; type?: ToastType }) => {
      const id = Math.random().toString(36).substring(2, 9);
      const type = options?.type ?? 'info';
      const description = options?.description;

      const newToast: ToastMessage = { id, title, description, type };

      setToasts((prev) => [...prev.slice(-4), newToast]); // Keep maximum 5 toasts

      setTimeout(() => {
        removeToast(id);
      }, 4000);
    },
    [removeToast],
  );

  const success = useCallback(
    (title: string, description?: string) => showToast(title, { description, type: 'success' }),
    [showToast],
  );

  const error = useCallback(
    (title: string, description?: string) => showToast(title, { description, type: 'error' }),
    [showToast],
  );

  const info = useCallback(
    (title: string, description?: string) => showToast(title, { description, type: 'info' }),
    [showToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, showToast, removeToast, success, error, info }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full px-4 pointer-events-none sm:px-0">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-start justify-between gap-3 rounded-xl p-4 shadow-lg ring-1 transition-all animate-in fade-in slide-in-from-bottom-2 duration-200',
              toast.type === 'success' && 'bg-emerald-900 text-white ring-emerald-700',
              toast.type === 'error' && 'bg-rose-900 text-white ring-rose-700',
              toast.type === 'warn' && 'bg-amber-900 text-white ring-amber-700',
              toast.type === 'info' && 'bg-ink-900 text-white ring-ink-700',
            )}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="text-base shrink-0 mt-0.5">
                {toast.type === 'success' && '✓'}
                {toast.type === 'error' && '✕'}
                {toast.type === 'warn' && '⚠️'}
                {toast.type === 'info' && 'ℹ️'}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-1 text-xs opacity-90 leading-snug">{toast.description}</p>
                ) : null}
              </div>
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="text-white/70 hover:text-white text-xs font-bold shrink-0 p-1"
              aria-label="Close toast"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
