// When a usage or rate limit a host reported lifts, from the words of its own error record: the parts of that reading
// every host shares. Each host adapter recognises its own record and passes the words here; the project run's gate
// (lib/project-limit.mjs) clamps whatever comes back, so a text that names a far time never stretches a pause past its cap.
// Every function answers a time in milliseconds since the epoch, `FAR` for a reset the text dates on another day, or null
// when the words name no time it can read.

const MINUTE = 60_000;
// A reset the text dates on another day, as `resets Oct 9, 5pm`: later than any pause may last.
export const FAR = Number.POSITIVE_INFINITY;
const UNITS = { second: 1000, sec: 1000, minute: MINUTE, min: MINUTE, hour: 60 * MINUTE, hr: 60 * MINUTE, day: 24 * 60 * MINUTE };
const MONTH = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/iu;
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?![a-z])|\b(\d{1,2}):(\d{2})\b/iu;

// The time `seconds` since the epoch names, when it is a whole number of seconds within a day before or a week after `now`.
export function epochTime(seconds, now) {
  const at = Number(seconds) * 1000;
  return Number.isInteger(Number(seconds)) && at > now - 24 * 60 * MINUTE && at < now + 7 * 24 * 60 * MINUTE ? at : null;
}

// The time `text`, as `2 hours 5 minutes` or `~37 min`, after `now`.
export function durationTime(text, now) {
  let total = 0;
  for (const [, count, unit] of String(text).matchAll(/(\d{1,4})\s*(second|sec|minute|min|hour|hr|day)s?\b/giu)) {
    total += Number(count) * UNITS[unit.toLowerCase()];
  }
  return total > 0 ? now + total : null;
}

// The next time after `now` a clock in the time zone `zone` (the system's when null, or when the host names one this
// runtime does not know) shows the time `text` names, as `5pm`, `3:04 PM`, or `17:30`; FAR when the text also names a
// month and day.
export function clockTime(text, now, zone = null) {
  const words = String(text);
  if (MONTH.test(words)) return FAR;
  const match = CLOCK.exec(words);
  if (!match) return null;
  let hour = Number(match[1] ?? match[4]);
  const minute = Number(match[2] ?? match[5] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  if (hour > 23 || minute > 59) return null;
  const shown = wallClock(now, zone);
  let ahead = (hour * 60 + minute) - (shown.hour * 60 + shown.minute);
  if (ahead <= 0) ahead += 24 * 60;
  return now + ahead * MINUTE - shown.second * 1000;
}

// The hour, minute, and second a clock in `zone` shows at `now`, the system's own when the zone is null or unknown.
function wallClock(now, zone) {
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', ...(zone ? { timeZone: zone } : {}) });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(now)).map(({ type, value }) => [type, Number(value)]));
  return { hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}
