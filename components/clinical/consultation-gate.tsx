'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

/**
 * Lets the consultation panel stand between the doctor and "Complete & Call
 * Next".
 *
 * The panel and the queue button are siblings on the page and know nothing of
 * each other. The panel registers a gate — "save whatever is unsaved, and tell
 * me whether that worked" — and the button runs it before advancing. If the
 * save fails, the queue does not move: finishing a consultation must never
 * silently discard the prescription the doctor just wrote.
 *
 * Outside a provider (the reception view) there is no gate and the button
 * behaves exactly as it always has.
 */
type Gate = () => Promise<boolean>;

type GateContext = {
  register: (gate: Gate | null) => void;
  run: () => Promise<boolean>;
};

const Context = createContext<GateContext | null>(null);

export function ConsultationGateProvider({ children }: { children: ReactNode }) {
  const gateRef = useRef<Gate | null>(null);
  const value = useMemo<GateContext>(
    () => ({
      register: (gate) => {
        gateRef.current = gate;
      },
      run: async () => (gateRef.current ? gateRef.current() : true),
    }),
    [],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** For the queue button: null when no consultation panel can be on screen. */
export function useConsultationGate(): GateContext | null {
  return useContext(Context);
}

/** For the panel: registers its gate for as long as it is mounted. */
export function useRegisterConsultationGate(gate: Gate) {
  const context = useContext(Context);
  useEffect(() => {
    context?.register(gate);
    return () => context?.register(null);
  }, [context, gate]);
}
