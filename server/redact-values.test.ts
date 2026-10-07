import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createStreamRedactor, redactValues, STREAM_HOLD_MAX_CHARS } from './redact-values.ts'

const SECRET = 'example-token-0123456789'
// Holds a `/` and a `$`, so its percent-encoded and compose-escaped forms do not contain it
// literally and only the decoders can find it.
const OTHER = 'another/secret$value'
// Longest first, as the callers pass them.
const VALUES = [SECRET, OTHER]

// One line per form redactValues recognises, with both line-end styles a stream carries.
const SAMPLE = [
  'starting service\n',
  `API_TOKEN=${SECRET}\n`,
  `prefix only: ${SECRET.slice(0, 14)}…\r\n`,
  `basic auth: ${Buffer.from(`alice:${SECRET}`).toString('base64')}\n`,
  `url: postgres://alice:${encodeURIComponent(OTHER)}@db/app\n`,
  `json: {"token":"${SECRET.replace(/-/g, '\\u002d')}"}\n`,
  `compose: pw=${OTHER.replace('$', '$$$$')}\n`,
  'progress 10%\rprogress 50%\rprogress 100%\n',
  'done, no newline at the end',
].join('')

function streamed(chunks: string[], values: string[] = VALUES): string {
  const redactor = createStreamRedactor(values)
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.flush()
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size))
  }
  return out
}

describe('redactValues', () => {
  test('removes every form of the sample credential', () => {
    const out = redactValues(SAMPLE, VALUES)
    assert.ok(!out.includes(SECRET))
    assert.ok(!out.includes(OTHER))
    assert.ok(!out.includes(SECRET.slice(0, 14)))
    assert.ok(!out.includes(Buffer.from(`alice:${SECRET}`).toString('base64')))
    assert.ok(!out.includes(encodeURIComponent(OTHER)))
    assert.ok(!out.includes('another/secret$$value'))
    assert.ok(!out.includes('\\u002d'))
    assert.ok(out.includes('starting service'))
  })

  test('finds a value visible only through compose escaping', () => {
    // No run of it in the escaped form is long enough to count as a prefix, so only undoing the
    // doubled `$` can find it.
    const value = 'pw$example-9876'
    assert.equal(redactValues('password: pw$$example-9876\n', [value]), 'password: [redacted]\n')
  })

  test('returns the text unchanged when there are no values', () => {
    assert.equal(redactValues(SAMPLE, []), SAMPLE)
  })
})

describe('createStreamRedactor', () => {
  test('matches whole-text redaction for every two-piece split of the sample', () => {
    const whole = redactValues(SAMPLE, VALUES)
    for (let cut = 0; cut <= SAMPLE.length; cut++) {
      assert.equal(streamed([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]), whole, `split at ${cut}`)
    }
  })

  test('matches whole-text redaction for pieces of every size from 1 to 16', () => {
    const whole = redactValues(SAMPLE, VALUES)
    for (let size = 1; size <= 16; size++) {
      assert.equal(streamed(chunksOf(SAMPLE, size)), whole, `pieces of ${size}`)
    }
  })

  test('holds an unterminated line back instead of releasing half a credential', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(`API_TOKEN=${SECRET.slice(0, 8)}`), '')
    assert.equal(redactor.push(`${SECRET.slice(8)}\nnext`), 'API_TOKEN=[redacted]\n')
    assert.equal(redactor.flush(), 'next')
  })

  test('releases a line on a carriage return', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push('progress 10%\rprogress'), 'progress 10%\r')
  })

  test('flushes what is held, redacted, when the stream ends', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(`last words ${SECRET}`), '')
    assert.equal(redactor.flush(), 'last words [redacted]')
    assert.equal(redactor.flush(), '')
  })

  test('releases an over-long unterminated run at its last whitespace, keeping the tail whole', () => {
    const filler = 'word '.repeat(Math.ceil(STREAM_HOLD_MAX_CHARS / 5) + 10)
    const text = `${filler}${SECRET}`
    const redactor = createStreamRedactor(VALUES)
    const released = redactor.push(text)
    assert.equal(released, filler)
    assert.equal(redactor.flush(), '[redacted]')
  })

  test('releases an over-long run with no whitespace at all rather than holding it forever', () => {
    const run = 'x'.repeat(STREAM_HOLD_MAX_CHARS + 1)
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(run), run)
    assert.equal(redactor.flush(), '')
  })

  test('passes text through, still line by line, when there are no values', () => {
    assert.equal(streamed(chunksOf(SAMPLE, 3), []), SAMPLE)
  })
})
