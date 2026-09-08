/** Credential-safe text for ACP errors and management process output. */

/**
 * Remove known credential values and common authorization fragments from diagnostic text.
 * @param text - provider-controlled diagnostic or stderr content.
 * @param secrets - credential values known to the current operation.
 * @returns readable diagnostic text with authentication material replaced.
 */
export function redactAcpText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const value of [...new Set(secrets)].filter(value => value.length > 0).sort((a, b) => b.length - a.length)) result = result.split(value).join('[redacted]')
  return result
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,}"']+/giu, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|api_key|token|key)=)[^\s&#]+/giu, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
}

/**
 * Select secret launch values without redacting ordinary executable paths or locales.
 * @param env - exact environment overrides for this instance.
 * @returns credential values used only for redaction.
 */
export function environmentSecrets(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).filter(([key]) => /key|token|secret|password|authorization/iu.test(key)).map(([, value]) => value)
}
