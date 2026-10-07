import host from '@ext/host'

import { createStreamRedactor, MIN_VALUE_LENGTH, redactValues, type StreamRedactor } from './redact-values'

// Container output is redacted against the values the Secrets Store actually holds, not against
// patterns that look credential-shaped. A pattern list only ever covers the shapes someone thought
// of, and a credential that matches none of them still leaks; the store already knows what the
// real values are.
//
// WHAT THIS REVERSES: a value appearing literally; a value appearing as a prefix of at least
// MIN_PREFIX_LENGTH characters; and a value inside base64, base64url, percent-encoded,
// JSON-escaped or compose-escaped text, nested up to MAX_DECODE_DEPTH. Encoded text is decoded and
// searched rather than the value being encoded and matched, because a log line usually encodes
// something LARGER than the credential — `base64(user + ':' + password)` does not contain
// `base64(password)` unless the offset happens to be a multiple of three.
//
// WHAT IT DOES NOT REVERSE, said plainly rather than left to be discovered: hex, gzip, and any
// encryption; a value shorter than MIN_VALUE_LENGTH; a fragment of a value that is neither a
// prefix nor at least MIN_PREFIX_LENGTH long; and a value split across two log lines. Output shown
// while it is produced — the Deploy and Logs tabs — goes through the same values, a line at a time
// (openStreamRedactor). The interactive Terminal tab does not: it is a shell a person types into,
// not output this module is handed.
//
// WHAT COUNTS AS A CREDENTIAL HERE IS AN ENUMERATION, NOT A DESCRIPTION, and it is exactly two
// things:
//
//   1. a value the Secrets Store holds;
//   2. the userinfo password of anything that parses IN ITS ENTIRETY as a hierarchical URL — an
//      Application node's `env` value as a whole, and each of its comma- or whitespace-separated
//      tokens. `scheme://u:pw@host` qualifies; a credential sitting anywhere else does not.
//
// The second is included because that position is a password by the URL grammar — a parse rather
// than a guess about what a secret looks like.
//
// WHAT THAT LEAVES OUT, stated as narrowly as it is implemented:
//
//   - a bare password typed into `env` as a plain value. It never reaches listAll() and is not a
//     URL password, so nothing here can know it is one — while it is still in the container's
//     environment, which is exactly where a startup error echoes it.
//   - `user:token@owner/repo`, one of the documented registry-entry forms. It PARSES, so nothing
//     fails: WHATWG reads `user:` as the scheme and the rest as an opaque path, the token lands in
//     `pathname`, and an empty `password` here is indistinguishable from a value that has no
//     credential at all. Recognising it means recognising a format, not parsing a URL.
//   - `token@owner/repo`, the schemeless shorthand — not a URL, and the same objection applies.
//
// So the claim this module supports is "stored secret values, and passwords in the userinfo
// position of a URL, are redacted". That is deliberately narrower than "credentials do not appear
// in container logs", and the two differ by wherever someone last typed a bare password into an
// `env` field. Widening it by detecting secret-shaped strings, or by reading credential-ish key
// names, is rejected — see `urlPasswords` below for what each gets wrong on ordinary
// configuration.

/**
 * The userinfo password of any token in an Application node's `env` that parses, whole, as a URL.
 *
 * This is a credential by GRAMMAR, not by appearance: in `scheme://user:pw@host`, `pw` occupies a
 * position the URL syntax defines as a password. Recognising it is a parse. Nothing here judges
 * whether a value looks secret-shaped, and nothing here reads a key's NAME — both of those are
 * guesses, and each fails on ordinary configuration:
 *
 *   - Treating every `env` literal as a known value would redact hostnames, ports, model names and
 *     absolute paths — what keys like HOST, PORT, MODEL and NODE_OPTIONS hold — out of every log.
 *   - Selecting by key name is wrong in both directions: an AUTH_URL matches a credential-ish name
 *     and holds a hostname, while a DATABASE_URL matches nothing and commonly carries a password.
 *
 * Both forms are collected. `URL` exposes the password percent-encoded, and a log can carry either
 * that or the decoded original depending on what built the line.
 */
async function urlPasswords(): Promise<string[]> {
  const values: string[] = []
  for (const node of await host.graph.listNodesByType('application')) {
    const env = node.data?.env
    if (typeof env !== 'string') {
      continue
    }
    for (const line of env.split('\n')) {
      const separator = line.indexOf('=')
      if (separator <= 0) {
        continue
      }
      // The whole value AND each of its tokens, because neither alone is a superset of the other.
      // One env value can hold several entries — EXTENSION_REGISTRIES is documented as a
      // comma-separated list — which the whole-value parse cannot see past. But a comma is a legal
      // sub-delimiter INSIDE a userinfo password, and a space survives as `%20`, so splitting alone
      // breaks `postgresql://user:p,ssw0rd@db/x` into tokens that no longer parse and drops a
      // password that the whole-value parse collects. `knownValues` dedupes through a Set, so the
      // union costs nothing and trades nothing away.
      const value = line.slice(separator + 1)
      for (const token of [value, ...value.split(/[\s,]+/)]) {
        if (!token) {
          continue
        }
        let url: URL
        try {
          url = new URL(token)
        } catch {
          continue
        }
        // An empty password is NOT the same as "no credential", and the difference is invisible
        // from here. `user:token@owner/repo` parses without throwing — `user:` becomes the scheme,
        // the rest an opaque path — so the token sits in `pathname` and this reads as a value with
        // nothing to hide. Named as uncovered at the head of this file rather than guessed at.
        if (!url.password) {
          continue
        }
        values.push(url.password)
        try {
          values.push(decodeURIComponent(url.password))
        } catch {
          // A stray `%` makes decodeURIComponent throw; the raw form above still covers the line.
        }
      }
    }
  }
  return values
}

/**
 * Everything this module knows to be a credential, longest first so that a short value which is a
 * substring of a longer one cannot cut the longer one's match in half and leave the remainder in
 * the text.
 *
 * Two sources, and the list is exactly these two rather than a description of a category:
 * every value the Secrets Store holds, and the password component of a URL in a node's `env`.
 * Anything else is not covered — see the head of this file.
 *
 * Instance-wide on purpose. Reading logs takes a container id, so the container being read is not
 * necessarily the one whose node carries the secrets, and narrowing to a node's own would leave
 * every other container's credentials in the clear. `listNodesByType` spans every space, which is
 * the matching scope.
 */
async function knownValues(): Promise<string[]> {
  const values = new Set<string>()
  for (const record of await host.secrets.listAll()) {
    if (record.value.length >= MIN_VALUE_LENGTH) {
      values.add(record.value)
    }
  }
  for (const password of await urlPasswords()) {
    if (password.length >= MIN_VALUE_LENGTH) {
      values.add(password)
    }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

/**
 * Remove every stored secret value from `text`.
 *
 * Takes no options by design: a caller returning container output to its requester must not be
 * able to ask for the unredacted form, so there is nothing to ask with.
 *
 * Throws when either source cannot be read — the store or the graph. Returning the text unredacted
 * on a failed lookup would make the one path that matters fall open silently, which is worse than
 * the read failing. Adding the graph as a source widens what can fail this way, and that is the
 * intended direction: a read that cannot establish what to hide must not proceed to show it.
 */
export async function redactSecrets(text: string): Promise<string> {
  return redactValues(text, await knownValues())
}

/**
 * A redactor for output that arrives while it is being produced — see createStreamRedactor for
 * what it holds back and why.
 *
 * The values are read once, when it is opened: a secret added to the store while a stream runs is
 * not hidden in that stream, and is in the next one. Throws exactly when redactSecrets would, so a
 * stream that cannot establish what to hide does not start.
 */
export async function openStreamRedactor(): Promise<StreamRedactor> {
  return createStreamRedactor(await knownValues())
}
