import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from '../src/client/locales.ts'

const chinese = new LocaleRuntime(new Context())
chinese.register('paperai.acp', { zh, en })
chinese.setLocale('zh')
const englishLocale = new LocaleRuntime(new Context())
englishLocale.register('paperai.acp', { zh, en })
englishLocale.setLocale('en')

/** Translate test controls through the shipped dictionary, including interpolated labels. */
export const t = chinese.bind('paperai.acp')
/** English translator for the same public interface. */
export const english = englishLocale.bind('paperai.acp')
