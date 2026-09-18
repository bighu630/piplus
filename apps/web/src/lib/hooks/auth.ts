import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { checkAuth, getAuthStatus, login } from '../api';
import { clearToken, getToken, maybeRefreshToken, setToken, LOGOUT_EVENT_NAME } from '../auth-session';

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth', 'status'],
    queryFn: getAuthStatus,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useAuthSession() {
  const queryClient = useQueryClient();
  const statusQuery = useAuthStatus();
  const requiresPassword = statusQuery.data?.requiresPassword ?? true;

  const query = useQuery({
    queryKey: ['auth', 'session'],
    queryFn: async () => {
      if (!getToken()) return null;
      // Proactively refresh when the token is close to expiry (deduped).
      await maybeRefreshToken();
      const token = getToken();
      if (!token) return null;
      return checkAuth(token);
    },
    enabled: requiresPassword,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // When any protected request gets a 401, auth-session broadcasts a logout:
  // drop the cached session so App renders the login screen again.
  useEffect(() => {
    const onLoggedOut = () => {
      queryClient.setQueryData(['auth', 'session'], null);
    };
    window.addEventListener(LOGOUT_EVENT_NAME, onLoggedOut);
    return () => window.removeEventListener(LOGOUT_EVENT_NAME, onLoggedOut);
  }, [queryClient]);

  return query;
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => login(password),
    onSuccess: (data) => {
      setToken(data.token);
      queryClient.setQueryData(['auth', 'session'], data);
    },
    // Errors (including 429 RATE_LIMITED messages) propagate as Error with the
    // server-provided message; consumers render mutation.error.message.
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      clearToken();
    },
    onSettled: () => {
      queryClient.clear();
    },
  });
}
