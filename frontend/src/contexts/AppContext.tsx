import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { PageAIContext } from '../services/ai/ai';

type Theme = 'light' | 'dark';

interface AppContextValue {
  theme: Theme;
  toggleTheme: () => void;
  aiOpen: boolean;
  openAI: () => void;
  closeAI: () => void;
  /** @deprecated use pageAIContext */
  aiContextHint: string;
  setAiContextHint: (hint: string) => void;
  pageAIContext: PageAIContext | null;
  setPageAIContext: (ctx: PageAIContext | null) => void;
  notesRefreshToken: number;
  bumpNotesRefresh: () => void;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem('aidrivenote.theme') as Theme) || 'light',
  );
  const [aiOpen, setAiOpen] = useState(false);
  const [aiContextHint, setAiContextHint] = useState('');
  const [pageAIContext, setPageAIContext] = useState<PageAIContext | null>(null);
  const [notesRefreshToken, setNotesRefreshToken] = useState(0);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'light' ? 'dark' : 'light';
      localStorage.setItem('aidrivenote.theme', next);
      document.documentElement.classList.toggle('dark', next === 'dark');
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      theme,
      toggleTheme,
      aiOpen,
      openAI: () => setAiOpen(true),
      closeAI: () => setAiOpen(false),
      aiContextHint,
      setAiContextHint,
      pageAIContext,
      setPageAIContext,
      notesRefreshToken,
      bumpNotesRefresh: () => setNotesRefreshToken(t => t + 1),
    }),
    [theme, toggleTheme, aiOpen, aiContextHint, pageAIContext, notesRefreshToken],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
