// ---------------------------------------------------------------------------
// Time handling for lobbies
// ---------------------------------------------------------------------------
//
// The whole module works in one direction only: pick an instant in UTC, then ASK what
// that instant looks like in a member's zone. It never takes a typed local wall-clock
// time and tries to convert it to UTC, because that inversion is where daylight-saving
// bugs live - a local time can be ambiguous (it happens twice) or nonexistent (it is
// skipped). Scanning forward in UTC and labelling with Intl is always well defined.
//
// Pure: no Discord, no state, no I/O.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * MINUTE_MS;

// Member-local blocks. 'late' starts at 22:00 and runs past midnight; an instant at
// 00:30 counts toward the block that began the previous evening.
const BLOCKS = ['morning', 'afternoon', 'evening', 'late'];

const BLOCK_LABELS = {
    morning: 'Morning (6am-12pm)',
    afternoon: 'Afternoon (12pm-5pm)',
    evening: 'Evening (5pm-10pm)',
    late: 'Late (10pm-2am)'
};

// Slots are only offered between these member-local times, so nobody is offered a
// 4am lobby. 01:30 is the last slot of the night.
const EARLIEST_HOUR = 6;
const LATEST_HOUR = 1;
const LATEST_MINUTE = 30;

// Common names people actually type, mapped to IANA zones.
const ZONE_ALIASES = {
    eastern: 'America/New_York',
    et: 'America/New_York',
    est: 'America/New_York',
    edt: 'America/New_York',
    central: 'America/Chicago',
    ct: 'America/Chicago',
    cst: 'America/Chicago',
    cdt: 'America/Chicago',
    mountain: 'America/Denver',
    mt: 'America/Denver',
    mst: 'America/Denver',
    pacific: 'America/Los_Angeles',
    pt: 'America/Los_Angeles',
    pst: 'America/Los_Angeles',
    pdt: 'America/Los_Angeles',
    alaska: 'America/Anchorage',
    hawaii: 'Pacific/Honolulu',
    uk: 'Europe/London',
    gmt: 'Europe/London',
    bst: 'Europe/London',
    london: 'Europe/London',
    ireland: 'Europe/Dublin',
    cet: 'Europe/Paris',
    paris: 'Europe/Paris',
    berlin: 'Europe/Berlin',
    madrid: 'Europe/Madrid',
    rome: 'Europe/Rome',
    amsterdam: 'Europe/Amsterdam',
    stockholm: 'Europe/Stockholm',
    moscow: 'Europe/Moscow',
    india: 'Asia/Kolkata',
    ist: 'Asia/Kolkata',
    japan: 'Asia/Tokyo',
    jst: 'Asia/Tokyo',
    korea: 'Asia/Seoul',
    china: 'Asia/Shanghai',
    singapore: 'Asia/Singapore',
    sydney: 'Australia/Sydney',
    melbourne: 'Australia/Melbourne',
    perth: 'Australia/Perth',
    brisbane: 'Australia/Brisbane',
    auckland: 'Pacific/Auckland',
    nz: 'Pacific/Auckland',
    brazil: 'America/Sao_Paulo',
    mexico: 'America/Mexico_City',
    toronto: 'America/Toronto',
    vancouver: 'America/Vancouver',
    utc: 'UTC'
};

// Used only when Intl.supportedValuesOf is unavailable, so the timezone autocomplete
// still has something to offer.
const FALLBACK_ZONES = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto',
    'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax',
    'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago',
    'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Europe/London', 'Europe/Dublin',
    'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Brussels', 'Europe/Amsterdam',
    'Europe/Berlin', 'Europe/Zurich', 'Europe/Rome', 'Europe/Vienna', 'Europe/Prague',
    'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen',
    'Europe/Helsinki', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Kyiv', 'Europe/Istanbul',
    'Europe/Moscow', 'Africa/Casablanca', 'Africa/Lagos', 'Africa/Johannesburg',
    'Africa/Nairobi', 'Africa/Cairo', 'Asia/Jerusalem', 'Asia/Dubai', 'Asia/Karachi',
    'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Seoul', 'Asia/Tokyo',
    'Asia/Manila', 'Australia/Perth', 'Australia/Brisbane', 'Australia/Sydney',
    'Australia/Melbourne', 'Australia/Adelaide', 'Pacific/Auckland', 'Pacific/Fiji'
];

// Intl.DateTimeFormat construction is comparatively expensive and this runs per member
// per hour in the overlap stats, so formatters are cached by zone.
const formatterCache = new Map();

function partsFormatter(zone) {
    let cached = formatterCache.get(zone);

    if (!cached) {
        cached = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: false
        });
        formatterCache.set(zone, cached);
    }

    return cached;
}

function isValidZone(zone) {
    if (typeof zone !== 'string' || !zone.trim()) return false;

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch (error) {
        return false;
    }
}

// Resolves what a member might type into an IANA zone, or null. Aliases first, then an
// exact/loose match against the real zone list, so "new york" finds America/New_York.
function resolveZone(input) {
    if (typeof input !== 'string') return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    const alias = ZONE_ALIASES[trimmed.toLowerCase()];
    if (alias) return alias;

    if (isValidZone(trimmed)) return trimmed;

    const needle = trimmed.toLowerCase().replace(/[\s_]+/g, '');
    const match = allZones().find(zone => zone.toLowerCase().replace(/[\s_/]+/g, '').includes(needle));

    return match || null;
}

function allZones() {
    if (typeof Intl.supportedValuesOf === 'function') {
        try {
            return Intl.supportedValuesOf('timeZone');
        } catch (error) {
            // Fall through to the bundled list.
        }
    }

    return FALLBACK_ZONES;
}

// Autocomplete choices for /availability timezone.
function zoneChoices(query) {
    const q = String(query || '').trim().toLowerCase();
    const zones = allZones();

    if (!q) {
        const common = FALLBACK_ZONES.slice(0, 25).filter(isValidZone);
        return common.map(zone => ({ name: zoneChoiceLabel(zone), value: zone }));
    }

    const aliasHit = ZONE_ALIASES[q];
    const results = [];

    if (aliasHit) results.push(aliasHit);

    const needle = q.replace(/[\s_]+/g, '');

    for (const zone of zones) {
        if (results.length >= 25) break;
        if (results.includes(zone)) continue;
        if (zone.toLowerCase().replace(/[\s_/]+/g, '').includes(needle)) results.push(zone);
    }

    return results.slice(0, 25).map(zone => ({ name: zoneChoiceLabel(zone), value: zone }));
}

function zoneChoiceLabel(zone) {
    const offset = offsetLabel(Date.now(), zone);
    const label = `${zone.replace(/_/g, ' ')}${offset ? ` (${offset})` : ''}`;
    return label.slice(0, 100);
}

function offsetLabel(instantMs, zone) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
            .formatToParts(new Date(instantMs));
        return parts.find(p => p.type === 'timeZoneName')?.value || '';
    } catch (error) {
        return '';
    }
}

// What an instant looks like in a zone. weekday is 0=Sunday.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(instantMs, zone) {
    const parts = partsFormatter(zone).formatToParts(new Date(instantMs));
    const get = type => parts.find(p => p.type === type)?.value || '';

    // en-US hour12:false renders midnight as 24 in some ICU versions.
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;

    const weekdayName = get('weekday');

    return {
        year: Number(get('year')),
        monthName: get('month'),
        day: Number(get('day')),
        weekdayName,
        weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
        hour,
        minute: Number(get('minute')),
        dayKey: `${get('year')}-${get('month')}-${get('day')}`
    };
}

function localDayKey(instantMs, zone) {
    return localParts(instantMs, zone).dayKey;
}

function localHour(instantMs, zone) {
    return localParts(instantMs, zone).hour;
}

// ISO-style YYYY-MM-DD in the given zone, for per-day counters.
function localIsoDate(instantMs, zone) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date(instantMs));
    } catch (error) {
        return new Date(instantMs).toISOString().slice(0, 10);
    }
}

// Which availability block a local hour falls in. Late wraps past midnight, so 00:xx and
// 01:xx belong to the previous evening's late block.
function blockForHour(hour) {
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    if (hour >= 22 || hour < 2) return 'late';
    return null; // 02:00-05:59: nobody's block
}

// Weekend means the local day the block belongs to, so a Friday 11pm 'late' slot counts
// as Friday (weekday), not Saturday.
function isWeekendLocal(instantMs, zone) {
    const parts = localParts(instantMs, zone);
    let weekday = parts.weekday;

    // Before 2am the block belongs to the previous day.
    if (parts.hour < 2) weekday = (weekday + 6) % 7;

    return weekday === 0 || weekday === 6;
}

// True when this instant falls inside one of the member's chosen blocks.
function matchesAvailability(instantMs, zone, weekdayBlocks, weekendBlocks) {
    const parts = localParts(instantMs, zone);
    const block = blockForHour(parts.hour);
    if (!block) return false;

    const blocks = isWeekendLocal(instantMs, zone) ? weekendBlocks : weekdayBlocks;
    return Array.isArray(blocks) && blocks.includes(block);
}

function isOfferableLocalTime(parts) {
    if (parts.hour >= EARLIEST_HOUR) return true;
    if (parts.hour < LATEST_HOUR) return true;
    if (parts.hour === LATEST_HOUR && parts.minute <= LATEST_MINUTE) return true;
    return false;
}

function formatClock(parts) {
    const h24 = parts.hour;
    const suffix = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const minute = String(parts.minute).padStart(2, '0');

    return `${h12}:${minute} ${suffix}`;
}

// `Thu Oct 15 · 8:00 PM`, with Today/Tomorrow replacing the date where it applies.
function slotLabel(instantMs, zone, nowMs) {
    const parts = localParts(instantMs, zone);
    const todayKey = localDayKey(nowMs, zone);
    const tomorrowKey = localDayKey(nowMs + DAY_MS, zone);

    let dayText;
    if (parts.dayKey === todayKey) dayText = 'Today';
    else if (parts.dayKey === tomorrowKey) dayText = 'Tomorrow';
    else dayText = `${parts.weekdayName} ${parts.monthName} ${parts.day}`;

    return `${dayText} · ${formatClock(parts)}`;
}

// Every offerable slot in the window, as { value, label }. value is UTC epoch SECONDS as
// a string, which is what the command option carries.
function generateSlots(nowMs, zone, { maxDays, minLeadMinutes }) {
    const slots = [];
    const earliest = nowMs + minLeadMinutes * MINUTE_MS;

    // Round up to the next 30-minute boundary so labels land on :00 and :30.
    let cursor = Math.ceil(earliest / SLOT_MS) * SLOT_MS;
    const limit = nowMs + maxDays * DAY_MS;

    while (cursor <= limit) {
        const parts = localParts(cursor, zone);

        if (isOfferableLocalTime(parts)) {
            slots.push({
                value: String(Math.floor(cursor / 1000)),
                label: slotLabel(cursor, zone, nowMs),
                instantMs: cursor,
                parts
            });
        }

        cursor += SLOT_MS;
    }

    return slots;
}

// Every typed token must appear somewhere in the label, case-insensitively. Lets
// "fri 8" and "8 pm" both work without parsing anything.
function filterSlots(slots, query) {
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return slots;

    return slots.filter(slot => {
        const label = slot.label.toLowerCase();
        return tokens.every(token => label.includes(token));
    });
}

// With no typed text, offer prime-time first: the next slots between 5pm and 11pm local.
function defaultSlots(slots, limit = 25) {
    const prime = slots.filter(slot => slot.parts.hour >= 17 && slot.parts.hour <= 23);
    return (prime.length > 0 ? prime : slots).slice(0, limit);
}

// The next instant AFTER `fromMs` whose local weekday and time match. Found by scanning
// UTC forward and comparing local parts, so a week later is the same local wall-clock
// time even across a daylight-saving change.
//
// Returns null when that local time does not exist in the target week, which happens on
// a spring-forward day; the caller decides what to do rather than silently drifting.
function nextWeeklyOccurrence(fromMs, zone, weekday, hour, minute) {
    const step = 15 * MINUTE_MS;
    // Start just past `from` and allow nine days, so a scan started the moment after an
    // occurrence still finds the next one.
    let cursor = Math.ceil((fromMs + MINUTE_MS) / step) * step;
    const limit = fromMs + 9 * DAY_MS;

    while (cursor <= limit) {
        const parts = localParts(cursor, zone);

        if (parts.weekday === weekday && parts.hour === hour && parts.minute === minute) {
            return cursor;
        }

        cursor += step;
    }

    return null;
}

// Used by the stats overlap report: hour-of-week bucket for an instant in a zone.
function hourOfWeekBucket(instantMs, zone) {
    const parts = localParts(instantMs, zone);
    return parts.weekday * 24 + parts.hour;
}

module.exports = {
    MINUTE_MS,
    HOUR_MS,
    DAY_MS,
    SLOT_MS,
    SLOT_MINUTES,
    BLOCKS,
    BLOCK_LABELS,
    ZONE_ALIASES,
    FALLBACK_ZONES,
    isValidZone,
    resolveZone,
    allZones,
    zoneChoices,
    localParts,
    localDayKey,
    localHour,
    localIsoDate,
    blockForHour,
    isWeekendLocal,
    matchesAvailability,
    formatClock,
    slotLabel,
    generateSlots,
    filterSlots,
    defaultSlots,
    nextWeeklyOccurrence,
    hourOfWeekBucket,
};
