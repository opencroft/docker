// How known credential values are removed from text, given the values. Which values count as
// credentials, and where they are read from, is redact.ts's business; this module takes them as an
// argument and reaches nothing else, so it runs the same whether the text is a stored entry read
// back whole or a stream arriving in chunks.

const PLACEHOLDER = '[redacted]'

// Stored values shorter than this are not matched at all. Four and five character values include
// the config literals that occur throughout ordinary log text — "true", "root", "debug" — and
// redacting every occurrence of those would destroy the log without protecting a credential.
export const MIN_VALUE_LENGTH = 6

// A run at least this long that is the beginning of a stored value is treated as that value.
// Printing the first characters of a token is a common way to make a log line "safe", and a
// substring search never sees it. Twelve characters is long enough that matching one by accident
// is not a practical concern.
const MIN_PREFIX_LENGTH = 12

// How deep encodings may nest before the search gives up. Base64 of a URL-encoded value is two.
const MAX_DECODE_DEPTH = 2

// Runs a prefix could occupy. Excludes the separators that attach a token to its key (`=`, `:`,
// `@`) so that redacting a prefix does not also swallow the field name next to it.
const TOKEN_RUN = new RegExp(`[A-Za-z0-9+/_.~-]{${MIN_PREFIX_LENGTH},}`, 'g')

// The shortest base64 run that could carry a matchable value: four characters per three bytes.
const MIN_BASE64_RUN = Math.ceil(MIN_VALUE_LENGTH / 3) * 4

const JSON_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
}

/**
 * An encoding this module can reverse. `pattern` finds runs that could be encoded text — it is
 * deliberately loose, since decoding a run that turns out to be an ordinary word costs nothing and
 * missing one costs a credential. `decode` returns the decoded form, or null when the run does not
 * decode to anything other than itself.
 */
interface Encoding {
  pattern: RegExp
  decode(run: string): string | null
}

// The last three match whole tokens and leave it to `decode` to find the escape inside one, which
// selects the same runs as a pattern spelling the escape out (`[^\s]*%XX[^\s]*`) would. That form
// backtracks: on a long token with no escape in it the engine retries from every start position,
// and a single 64 KiB line took seconds per pattern.
const ENCODINGS: Encoding[] = [
  // base64, then the URL-safe alphabet.
  { pattern: new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_RUN},}={0,2}`, 'g'), decode: (run) => decodeBuffer(run, 'base64') },
  { pattern: new RegExp(`[A-Za-z0-9_-]{${MIN_BASE64_RUN},}`, 'g'), decode: (run) => decodeBuffer(run, 'base64url') },
  // Percent-encoding, as it appears inside a connection string or a query parameter.
  { pattern: /[^\s"'<>]+/g, decode: decodePercent },
  // JSON string escaping, as it appears when a payload is logged rather than a field.
  { pattern: /[^\s"]+/g, decode: decodeJsonEscapes },
  // Compose interpolation. A value written into a compose document has every `$` doubled so compose
  // does not read it as a variable reference, so a credential containing one is not itself in the
  // text — and compose echoes service definitions back on an error.
  { pattern: /[^\s"']+/g, decode: decodeComposeEscapes },
]

function decodeBuffer(run: string, encoding: 'base64' | 'base64url'): string | null {
  const decoded = Buffer.from(run, encoding).toString('utf-8')
  return decoded && decoded !== run ? decoded : null
}

function decodePercent(run: string): string | null {
  try {
    const decoded = decodeURIComponent(run)
    return decoded === run ? null : decoded
  } catch {
    // A stray `%`, or escapes that are not valid UTF-8, make decodeURIComponent throw. Decoding
    // byte-wise still recognises an ASCII credential, which is what matters here.
    const decoded = run.replace(/%[0-9A-Fa-f]{2}/g, (percentEscape) =>
      String.fromCharCode(Number.parseInt(percentEscape.slice(1), 16)),
    )
    return decoded === run ? null : decoded
  }
}

function decodeJsonEscapes(run: string): string | null {
  const decoded = run.replace(/\\u([0-9A-Fa-f]{4})|\\(.)/g, (_match: string, hex?: string, escaped?: string) => {
    if (hex) {
      return String.fromCharCode(Number.parseInt(hex, 16))
    }
    return escaped ? (JSON_ESCAPES[escaped] ?? escaped) : ''
  })
  return decoded === run ? null : decoded
}

function decodeComposeEscapes(run: string): string | null {
  const decoded = run.split('$$').join('$')
  return decoded === run ? null : decoded
}

/** True when `text` holds one of `values` — literally, or under any encoding this module reverses. */
function holdsValue(text: string, values: string[], depth: number): boolean {
  if (values.some((value) => text.includes(value))) {
    return true
  }
  if (depth >= MAX_DECODE_DEPTH) {
    return false
  }
  for (const encoding of ENCODINGS) {
    for (const run of text.match(encoding.pattern) ?? []) {
      const decoded = encoding.decode(run)
      if (decoded !== null && holdsValue(decoded, values, depth + 1)) {
        return true
      }
    }
  }
  return false
}

function redactLiterals(text: string, values: string[]): string {
  let out = text
  for (const value of values) {
    if (out.includes(value)) {
      out = out.split(value).join(PLACEHOLDER)
    }
  }
  return out
}

function redactPrefixes(text: string, values: string[]): string {
  return text.replace(TOKEN_RUN, (run) =>
    values.some((value) => value.length > run.length && value.startsWith(run)) ? PLACEHOLDER : run,
  )
}

// Replaces the whole encoded run, not the span the credential occupies inside it: the run decodes
// as a unit, so a partial replacement would leave a decodable remainder.
function redactEncoded(text: string, values: string[]): string {
  let out = text
  for (const encoding of ENCODINGS) {
    out = out.replace(encoding.pattern, (run) => {
      const decoded = encoding.decode(run)
      return decoded !== null && holdsValue(decoded, values, 1) ? PLACEHOLDER : run
    })
  }
  return out
}

/**
 * Remove every one of `values` from `text` — literally, as a long enough prefix, and inside any
 * encoding this module reverses. `values` must be sorted longest first, so that a short value
 * which is a substring of a longer one cannot cut the longer one's match in half.
 */
export function redactValues(text: string, values: string[]): string {
  if (!text || values.length === 0) {
    return text
  }
  return redactEncoded(redactPrefixes(redactLiterals(text, values), values), values)
}

// The longest stretch a stream redactor holds back waiting for a line end. Output that never ends
// a line (a progress bar drawn with no `\r`, a single enormous JSON line) would otherwise be held
// until the stream closed; past this it is released, cut at whitespace where there is any.
export const STREAM_HOLD_MAX_CHARS = 64 * 1024

/** Redaction for text that arrives in pieces. See createStreamRedactor. */
export interface StreamRedactor {
  /** Take the next piece; return whatever can now be released, redacted. */
  push(text: string): string
  /** Release everything still held, redacted. Call once, when the stream has ended. */
  flush(): string
}

/**
 * Redact a stream whose chunk boundaries fall anywhere — inside a line, a token, a base64 run.
 *
 * Text is released only up to the last line end (`\n` or `\r`), and the unterminated rest is held
 * for the next piece. No pattern `redactValues` matches crosses a line end, so a line redacted on
 * its own comes out exactly as it would inside the whole text: the concatenated output of a
 * stream equals `redactValues` over its concatenated input, wherever the chunks were cut. That
 * holds for values without a line break in them; a value split across two lines is outside what
 * `redactValues` finds in whole text too.
 *
 * The one place a stream can do worse than whole text is a run longer than
 * STREAM_HOLD_MAX_CHARS with no line end, which is released at its last whitespace, or whole when
 * it has none. A value straddling that cut is missed.
 */
export function createStreamRedactor(values: string[]): StreamRedactor {
  let held = ''
  return {
    push(text) {
      held += text
      const cut = releasePoint(held)
      const released = held.slice(0, cut)
      held = held.slice(cut)
      return redactValues(released, values)
    },
    flush() {
      const released = held
      held = ''
      return redactValues(released, values)
    },
  }
}

// Where `held` can be cut: after its last line end, unless that leaves more than the hold limit
// behind — then after its last whitespace, or at its end when there is none.
function releasePoint(held: string): number {
  const lineEnd = Math.max(held.lastIndexOf('\n'), held.lastIndexOf('\r')) + 1
  if (held.length - lineEnd <= STREAM_HOLD_MAX_CHARS) {
    return lineEnd
  }
  const afterSpace = held.search(/\s\S*$/) + 1
  return afterSpace > 0 && held.length - afterSpace <= STREAM_HOLD_MAX_CHARS ? afterSpace : held.length
}
