import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeDto, SessionDto } from '@socialpilot/shared';
import { api, get, refreshSession, setSession, setSessionListener } from './api';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  session: SessionDto | null;
  me: MeDto | undefined;
  meLoading: boolean;
  signIn: (s: SessionDto) => void;
  signOut: () => Promise<void>;
  refetchMe: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionDto | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const qc = useQueryClient();

  useEffect(() => {
    setSessionListener((s) => {
      setSessionState(s);
      setStatus(s ? 'authenticated' : 'anonymous');
    });
    void refreshSession();
  }, []);

  // Proactively refresh one minute before expiry.
  useEffect(() => {
    if (!session) return;
    const ms = session.expiresAt * 1000 - Date.now() - 60_000;
    const t = setTimeout(() => void refreshSession(), Math.max(ms, 5_000));
    return () => clearTimeout(t);
  }, [session]);

  const meQuery = useQuery({ queryKey: ['me'], queryFn: () => get<MeDto>('/v1/me'), enabled: status === 'authenticated' });

  const signIn = useCallback((s: SessionDto) => {
    qc.clear();
    setSession(s);
  }, [qc]);

  const signOut = useCallback(async () => {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    setSession(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, me: meQuery.data, meLoading: meQuery.isLoading, signIn, signOut, refetchMe: meQuery.refetch }),
    [status, session, meQuery.data, meQuery.isLoading, meQuery.refetch, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
