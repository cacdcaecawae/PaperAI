/** Browser-only helpers for bounded, canonical Word uploads. */

const MAX_WORD_BYTES = 32 * 1024 * 1024
const WORD_FILE = /\.docx?$/iu
const BASE64_CHUNK_BYTES = 24 * 1024

/**
 * Test whether one browser-selected file is a supported Word source.
 * @param file - file metadata to validate before reading browser bytes.
 * @returns `true` for a non-empty `.doc` or `.docx` file no larger than 32 MB.
 */
export function isWordFile(file: Pick<File, 'name' | 'size'>): boolean {
  return file.size > 0 && file.size <= MAX_WORD_BYTES && WORD_FILE.test(file.name)
}

/**
 * Read one bounded Word file as the canonical base64 payload accepted by the Host.
 * @param file - browser-selected `.doc` or `.docx` file to read.
 * @returns the complete file bytes encoded as base64.
 */
export async function readWordFileBase64(file: File): Promise<string> {
  if (!isWordFile(file)) {
    throw new Error('Select a non-empty .doc or .docx file no larger than 32 MB.')
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('The selected file could not be read.')) }
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('The selected file did not produce browser binary data.'))
        return
      }
      resolve(reader.result)
    }
    reader.readAsArrayBuffer(file)
  })
  const bytes = new Uint8Array(buffer)
  let encoded = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BASE64_CHUNK_BYTES, bytes.length))
    let binary = ''
    for (const byte of chunk) binary += String.fromCharCode(byte)
    encoded += btoa(binary)
  }
  return encoded
}

/**
 * Derive a human-readable template name from a selected Word file.
 * @param fileName - selected file name, including its Word extension.
 * @returns the trimmed name without `.doc` or `.docx`, or the original name when the stem is empty.
 */
export function wordStem(fileName: string): string {
  return fileName.replace(WORD_FILE, '').trim() || fileName
}
