/**
 * The window's language, and the lookup every component uses.
 *
 * A context rather than a prop: nearly every component shows text, and threading a translator
 * through each of them would be the whole diff. The provider re-renders the tree when the language
 * changes, which is what makes the setting take effect without a restart.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { resolveLanguage, translator, type Language, type Translate } from "@core/i18n";

const TextContext = createContext<Translate>(translator("en"));

export function TextProvider({ language, locale, children }: {
  language: Language;
  /** What the machine says, for when the setting is "system". */
  locale: string;
  children: ReactNode;
}) {
  const t = useMemo(() => translator(resolveLanguage(language, locale)), [language, locale]);
  return <TextContext.Provider value={t}>{children}</TextContext.Provider>;
}

/** The translator for the language in force. */
export function useText(): Translate {
  return useContext(TextContext);
}
