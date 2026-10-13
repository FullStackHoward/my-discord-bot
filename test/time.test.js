const { test } = require('node:test');
const assert = require('node:assert');
const time = require('../lib/lobby/time');

const NY = 'America/New_York';
const LON = 'Europe/London';

test('zone validation', () => {
    assert.ok(time.isValidZone(NY));
    assert.ok(time.isValidZone('UTC'));
    assert.ok(!time.isValidZone('Not/AZone'));
    assert.ok(!time.isValidZone(''));
    assert.ok(!time.isValidZone(null));
});

test('zone aliases resolve to IANA names', () => {
    assert.equal(time.resolveZone('eastern'), NY);
    assert.equal(time.resolveZone('PST'), 'America/Los_Angeles');
    assert.equal(time.resolveZone('uk'), LON);
    assert.equal(time.resolveZone(NY), NY);
    assert.equal(time.resolveZone('new york'), NY);
    assert.equal(time.resolveZone('absolute gibberish zone'), null);
});

test('blockForHour covers the day and leaves 2am-6am unclaimed', () => {
    assert.equal(time.blockForHour(7), 'morning');
    assert.equal(time.blockForHour(13), 'afternoon');
    assert.equal(time.blockForHour(19), 'evening');
    assert.equal(time.blockForHour(23), 'late');
    assert.equal(time.blockForHour(0), 'late');
    assert.equal(time.blockForHour(1), 'late');
    assert.equal(time.blockForHour(3), null);
    assert.equal(time.blockForHour(5), null);
});

test('localParts renders midnight as hour 0, not 24', () => {
    // 2026-10-15 04:00 UTC is midnight in New York.
    const parts = time.localParts(Date.UTC(2026, 9, 15, 4, 0), NY);
    assert.equal(parts.hour, 0);
    assert.equal(parts.day, 15);
});

test('after-midnight hours belong to the night that started them', () => {
    // Fri 2026-10-16 23:30 New York = Sat 03:30 UTC. Locally it is still Friday.
    const fridayLate = Date.UTC(2026, 9, 17, 3, 30);
    assert.equal(time.localParts(fridayLate, NY).weekday, 5, 'local clock says Friday');
    assert.equal(time.isWeekendLocal(fridayLate, NY), false, 'Friday night is a weekday night');

    // Sat 2026-10-17 00:30 New York = Sat 04:30 UTC. The clock says Saturday, but the
    // block belongs to Friday evening, so it must still count as a weekday.
    const saturdayEarly = Date.UTC(2026, 9, 17, 4, 30);
    assert.equal(time.localParts(saturdayEarly, NY).weekday, 6, 'local clock says Saturday');
    assert.equal(time.isWeekendLocal(saturdayEarly, NY), false,
        'Saturday 00:30 is Friday night, so it is weekday availability');

    // Sat 2026-10-17 20:00 New York really is the weekend.
    const saturdayEvening = Date.UTC(2026, 9, 18, 0, 0);
    assert.equal(time.isWeekendLocal(saturdayEvening, NY), true);
});

test('generateSlots respects the lead time and the offerable window', () => {
    const now = Date.UTC(2026, 9, 15, 12, 0);
    const slots = time.generateSlots(now, NY, { maxDays: 2, minLeadMinutes: 10 });

    assert.ok(slots.length > 0);
    assert.ok(slots.every(s => s.instantMs >= now + 10 * 60 * 1000), 'all slots clear the lead time');

    for (const slot of slots) {
        const h = slot.parts.hour;
        const ok = h >= 6 || h === 0 || (h === 1 && slot.parts.minute <= 30);
        assert.ok(ok, `slot at local ${h}:${slot.parts.minute} should not be offered`);
    }
});

test('slot values are UTC epoch seconds that round-trip', () => {
    const now = Date.UTC(2026, 9, 15, 12, 0);
    const [slot] = time.generateSlots(now, NY, { maxDays: 1, minLeadMinutes: 10 });

    assert.match(slot.value, /^\d+$/);
    assert.equal(Number(slot.value) * 1000, slot.instantMs);
});

test('slot labels use Today and Tomorrow', () => {
    const now = Date.UTC(2026, 9, 15, 16, 0); // noon in New York
    const slots = time.generateSlots(now, NY, { maxDays: 3, minLeadMinutes: 10 });

    assert.ok(slots.some(s => s.label.startsWith('Today')));
    assert.ok(slots.some(s => s.label.startsWith('Tomorrow')));
    assert.ok(slots.some(s => /^[A-Z][a-z]{2} /.test(s.label)), 'and a weekday for later days');
});

test('filterSlots requires every token to appear', () => {
    const slots = [
        { label: 'Thu Oct 15 · 8:00 PM' },
        { label: 'Fri Oct 16 · 8:00 PM' },
        { label: 'Fri Oct 16 · 9:00 PM' }
    ];

    assert.equal(time.filterSlots(slots, 'fri').length, 2);
    assert.equal(time.filterSlots(slots, 'fri 9').length, 1);
    assert.equal(time.filterSlots(slots, '8 pm').length, 2);
    assert.equal(time.filterSlots(slots, '').length, 3);
    assert.equal(time.filterSlots(slots, 'sunday').length, 0);
});

test('US autumn DST: a weekly series keeps its local time across Nov 1 2026', () => {
    // Sunday Oct 25 2026, 8:00 PM New York (EDT, UTC-4) = Oct 26 00:00 UTC.
    const first = Date.UTC(2026, 9, 26, 0, 0);
    const parts = time.localParts(first, NY);
    assert.equal(parts.hour, 20, 'starts at 8pm local');

    let cursor = first;
    const seen = [];

    for (let i = 0; i < 3; i++) {
        cursor = time.nextWeeklyOccurrence(cursor, NY, parts.weekday, parts.hour, parts.minute);
        assert.ok(cursor, 'an occurrence was found');
        seen.push(time.localParts(cursor, NY));
    }

    // Nov 1 2026 is the fall-back date, so the second and third occurrences are after it.
    for (const p of seen) {
        assert.equal(p.hour, 20, 'still 8pm local after the clock change');
        assert.equal(p.minute, 0);
        assert.equal(p.weekday, parts.weekday, 'still the same weekday');
    }

    // Proof the arithmetic is not a naive +7 days: across the fall-back the UTC gap has
    // to be 169 hours, not 168, to keep the same local wall-clock time.
    const gaps = [];
    let prev = first;
    let walk = first;

    for (let i = 0; i < 3; i++) {
        walk = time.nextWeeklyOccurrence(walk, NY, parts.weekday, parts.hour, parts.minute);
        gaps.push((walk - prev) / (60 * 60 * 1000));
        prev = walk;
    }

    assert.ok(gaps.includes(169), `expected a 169-hour gap across the DST change, saw ${gaps.join(', ')}`);
});

test('UK autumn DST: a weekly series keeps its local time across Oct 25 2026', () => {
    // Sunday Oct 18 2026, 8:00 PM London (BST, UTC+1) = 19:00 UTC.
    const first = Date.UTC(2026, 9, 18, 19, 0);
    const parts = time.localParts(first, LON);
    assert.equal(parts.hour, 20);

    let cursor = first;

    for (let i = 0; i < 3; i++) {
        cursor = time.nextWeeklyOccurrence(cursor, LON, parts.weekday, parts.hour, parts.minute);
        assert.ok(cursor);

        const p = time.localParts(cursor, LON);
        assert.equal(p.hour, 20, 'still 8pm London after the Oct 25 change');
        assert.equal(p.weekday, parts.weekday);
    }
});

test('nextWeeklyOccurrence returns an instant strictly in the future', () => {
    const first = Date.UTC(2026, 9, 26, 0, 0);
    const parts = time.localParts(first, NY);
    const next = time.nextWeeklyOccurrence(first, NY, parts.weekday, parts.hour, parts.minute);

    assert.ok(next > first);
    assert.ok(next - first >= 6 * 24 * 60 * 60 * 1000, 'about a week later');
    assert.ok(next - first <= 8 * 24 * 60 * 60 * 1000);
});

test('matchesAvailability maps a UTC instant into the right local block', () => {
    // 2026-10-15 23:00 UTC = 7pm New York, an evening weekday.
    const instant = Date.UTC(2026, 9, 15, 23, 0);

    assert.ok(time.matchesAvailability(instant, NY, ['evening'], []));
    assert.ok(!time.matchesAvailability(instant, NY, ['morning'], []));
    assert.ok(!time.matchesAvailability(instant, NY, [], ['evening']), 'weekend blocks do not apply on a Thursday');
});

test('localIsoDate gives a stable per-day key in the member zone', () => {
    // 03:00 UTC is still the previous day in New York.
    assert.equal(time.localIsoDate(Date.UTC(2026, 9, 15, 3, 0), NY), '2026-10-14');
    assert.equal(time.localIsoDate(Date.UTC(2026, 9, 15, 13, 0), NY), '2026-10-15');
});
