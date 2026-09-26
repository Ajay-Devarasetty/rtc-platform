export function currentMonth(now = new Date()) {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: now.toISOString() };
}

export function durationInPeriod(start: string, end: string | null, opts: { from?: string; to?: string }, now = Date.now()) {
  const lower = Math.max(Date.parse(start), opts.from ? Date.parse(opts.from) : -Infinity);
  const upper = Math.min(end ? Date.parse(end) : now, opts.to ? Date.parse(opts.to) : now);
  return Math.max(0, upper - lower);
}
