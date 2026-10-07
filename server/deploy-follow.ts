// The shell side of following a detached deploy. Kept free of host imports so it can be run for
// real in a test.

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * A script that prints its stdin (the compose document section), then follows the deploy's log
 * until the `.rc` file appears, prints the rest and exits.
 *
 * A polling loop rather than a backgrounded `tail -f`: stopping the job stops the shell, and a
 * foreground loop leaves nothing behind it, where a `tail -f` would outlive the shell and follow a
 * finished log forever. `.rc` is checked before each read, so the read after it appears takes in
 * everything compose wrote. The first read starts at most `maxBytes` from the end.
 */
export function deployFollowScript(paths: { logPath: string; rcPath: string }, maxBytes: number): string {
  return [
    'cat',
    `log=${shellQuote(paths.logPath)}`,
    `rc=${shellQuote(paths.rcPath)}`,
    'off=-1',
    'while :; do',
    '  ended=0',
    '  [ -s "$rc" ] && ended=1',
    '  size=$(wc -c < "$log" 2>/dev/null)',
    '  size=$((${size:-0}))',
    `  if [ "$off" -lt 0 ]; then off=$((size > ${maxBytes} ? size - ${maxBytes} : 0)); fi`,
    '  if [ "$size" -gt "$off" ]; then tail -c +$((off + 1)) "$log" | head -c $((size - off)); off=$size; fi',
    '  [ "$ended" = 1 ] && exit 0',
    '  sleep 1',
    'done',
  ].join('\n')
}
