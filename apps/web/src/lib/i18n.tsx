import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Minimal i18n (English / Kannada). Kannada strings are an initial draft and
 * should be reviewed by a native speaker before launch. Missing keys fall back to English.
 */
const kn: Record<string, string> = {
  Overview: 'ಅವಲೋಕನ',
  Dashboard: 'ಡ್ಯಾಶ್‌ಬೋರ್ಡ್',
  'WhatsApp Marketing': 'ವಾಟ್ಸ್‌ಆ್ಯಪ್ ಮಾರ್ಕೆಟಿಂಗ್',
  Inbox: 'ಇನ್‌ಬಾಕ್ಸ್',
  CRM: 'ಸಿಆರ್‌ಎಂ',
  Automation: 'ಸ್ವಯಂಚಾಲನೆ',
  'AI Center': 'ಎಐ ಕೇಂದ್ರ',
  Analytics: 'ವಿಶ್ಲೇಷಣೆ',
  Settings: 'ಸೆಟ್ಟಿಂಗ್‌ಗಳು',
  Contacts: 'ಸಂಪರ್ಕಗಳು',
  'Broadcast Campaigns': 'ಪ್ರಸಾರ ಅಭಿಯಾನಗಳು',
  'Team Members': 'ತಂಡದ ಸದಸ್ಯರು',
  'Business Profile': 'ವ್ಯವಹಾರದ ವಿವರ',
  'Sign out': 'ಸೈನ್ ಔಟ್',
  Search: 'ಹುಡುಕಿ',
  'Coming soon': 'ಶೀಘ್ರದಲ್ಲೇ ಬರಲಿದೆ',
  'Welcome back': 'ಮರಳಿ ಸ್ವಾಗತ',
  'Messages sent': 'ಕಳುಹಿಸಿದ ಸಂದೇಶಗಳು',
  Delivered: 'ತಲುಪಿದವು',
  Read: 'ಓದಲಾಗಿದೆ',
  Failed: 'ವಿಫಲವಾಗಿದೆ',
  Save: 'ಉಳಿಸಿ',
  Cancel: 'ರದ್ದುಮಾಡಿ',
};

type Lang = 'en' | 'kn';
const I18nContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string }>({
  lang: 'en',
  setLang: () => undefined,
  t: (s) => s,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('sp_lang') === 'kn' ? 'kn' : 'en'));
  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem('sp_lang', l);
    document.documentElement.lang = l;
  };
  const t = (s: string) => (lang === 'kn' ? kn[s] ?? s : s);
  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
