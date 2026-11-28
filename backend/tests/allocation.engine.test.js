// Unit tests for the Seat Allocation engine (owner: Mohamed Attallah).
// The engine is pure (no database, no AWS), so these run anywhere in a second:
//   cd backend && npm run test:engine
// Each test checks one allocation rule from the top of services/allocation/engine.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { usableSeats, orderHalls, quotas, plan, nextFreeSeat } = require('../services/allocation/engine');

const ROWS = 'ABCDEFGHIJ';

// Builds a hall's seats as a grid. blocked = list of labels like ['B4'].
function grid(hallId, rows, cols, blocked = []) {
  const seats = [];
  let id = hallId * 1000;
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      const label = `${ROWS[r - 1]}${c}`;
      id += 1;
      seats.push({ id, hallId, rowNo: r, colNo: c, label, status: blocked.includes(label) ? 'blocked' : 'available' });
    }
  }
  return seats;
}

function students(n, prefix = 'S') {
  // created in reverse order on purpose, to prove the engine sorts them
  return Array.from({ length: n }, (_, i) => {
    const num = n - i;
    return { id: num, studentCode: `${prefix}${String(num).padStart(3, '0')}` };
  });
}

const hallA = { id: 1, name: 'Hall A' }; // 5 x 8 = 40 seats
const hallB = { id: 2, name: 'Hall B' }; // 4 x 6 = 24 seats
const seatsA = grid(1, 5, 8, ['B4', 'C4']); // 38 usable
const seatsB = grid(2, 4, 6);                // 24 usable
const allSeats = [...seatsA, ...seatsB];
const seatById = new Map(allSeats.map((s) => [s.id, s]));

// Rule 5: blocked seats are never used.
test('blocked seats are skipped', () => {
  const usable = usableSeats(seatsA, false);
  assert.equal(usable.length, 38);
  assert.ok(usable.every((s) => s.status === 'available'));
  assert.ok(!usable.some((s) => ['B4', 'C4'].includes(s.label)));
});

// Rule 4: inside a hall, row by row (A first), left to right.
test('seats are taken row by row, left to right', () => {
  const labels = usableSeats(seatsB, false).slice(0, 8).map((s) => s.label);
  assert.deepEqual(labels, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2']);
});

// Rule 6: spacing uses only odd columns, so nobody sits side by side.
test('spacing uses only every other seat (odd columns)', () => {
  const usable = usableSeats(seatsB, true);
  assert.equal(usable.length, 12); // 4 rows x columns 1,3,5
  assert.ok(usable.every((s) => s.colNo % 2 === 1));
});

// Rule 2: halls ordered by usable capacity, largest first, then by name.
test('halls are ordered by usable capacity, largest first', () => {
  const ordered = orderHalls([hallB, hallA], allSeats, false);
  assert.deepEqual(ordered.map((h) => h.name), ['Hall A', 'Hall B']);
  const tie = orderHalls([{ id: 3, name: 'Zeta' }, { id: 4, name: 'Alpha' }],
    [...grid(3, 2, 2), ...grid(4, 2, 2)], false);
  assert.deepEqual(tie.map((h) => h.name), ['Alpha', 'Zeta']); // same size -> by name
});

// Rule 3 (fill): hall 1 is filled completely before hall 2 is used.
test('fill strategy fills the first hall completely before the next', () => {
  const q = quotas(orderHalls([hallA, hallB], allSeats, false), 50, 'fill');
  assert.deepEqual(q, [38, 12]);
});

// Rule 3 (balance): shares proportional to capacity, adding up exactly.
test('balance strategy spreads students in proportion to hall capacity', () => {
  const q = quotas(orderHalls([hallA, hallB], allSeats, false), 31, 'balance');
  assert.equal(q[0] + q[1], 31);
  assert.deepEqual(q, [19, 12]); // 38:24 capacity -> 19.0 : 12.0
});

test('balance never puts more students in a hall than it has seats', () => {
  const ordered = orderHalls([hallA, hallB], allSeats, false);
  const q = quotas(ordered, 62, 'balance'); // every usable seat
  assert.deepEqual(q, [38, 24]);
});

// Rule 1: students are seated in student-code order (repeatable result).
test('students are seated in student-code order', () => {
  const result = plan({ students: students(5), halls: [hallB], seats: seatsB });
  const seatOfStudent = result.assignments.map((a) => [a.studentId, seatById.get(a.seatId).label]);
  assert.deepEqual(seatOfStudent, [[1, 'A1'], [2, 'A2'], [3, 'A3'], [4, 'A4'], [5, 'A5']]);
});

test('the same input always gives the same plan', () => {
  const input = { students: students(40), halls: [hallA, hallB], seats: allSeats, strategy: 'balance' };
  assert.deepEqual(plan(input), plan(input));
});

// Integrity: one student per seat, one seat per student.
test('no seat is used twice and every student gets exactly one seat', () => {
  const result = plan({ students: students(50), halls: [hallA, hallB], seats: allSeats });
  const seatIds = result.assignments.map((a) => a.seatId);
  const studentIds = result.assignments.map((a) => a.studentId);
  assert.equal(new Set(seatIds).size, 50);
  assert.equal(new Set(studentIds).size, 50);
  assert.deepEqual(result.perHall.map((h) => h.seatsUsed), [38, 12]);
});

// Rule 7: not enough seats -> an error, and no assignments at all.
test('not enough usable seats returns NOT_ENOUGH_SEATS and seats nobody', () => {
  const result = plan({ students: students(30), halls: [hallB], seats: seatsB });
  assert.equal(result.error, 'NOT_ENOUGH_SEATS');
  assert.equal(result.needed, 30);
  assert.equal(result.available, 24);
  assert.equal(result.assignments, undefined);
});

test('spacing reduces capacity and can trigger NOT_ENOUGH_SEATS', () => {
  const result = plan({ students: students(20), halls: [hallB], seats: seatsB, spacing: true });
  assert.equal(result.error, 'NOT_ENOUGH_SEATS');
  assert.equal(result.available, 12);
});

test('an empty student list gives an empty plan, not an error', () => {
  const result = plan({ students: [], halls: [hallA], seats: seatsA });
  assert.equal(result.error, undefined);
  assert.equal(result.assignments.length, 0);
});

// Cross-service rule: when a seat is blocked, the student moves to the next free seat.
test('nextFreeSeat prefers the same hall and skips taken seats', () => {
  const taken = new Set(usableSeats(seatsB, false).slice(0, 3).map((s) => s.id));
  const seat = nextFreeSeat({ halls: [hallA, hallB], seats: allSeats, takenSeatIds: taken, spacing: false, preferHallId: 2 });
  assert.equal(seat.hallId, 2);
  assert.equal(seat.label, 'A4');
});

test('nextFreeSeat moves to another hall when the preferred hall is full', () => {
  const taken = new Set(seatsB.map((s) => s.id));
  const seat = nextFreeSeat({ halls: [hallA, hallB], seats: allSeats, takenSeatIds: taken, spacing: false, preferHallId: 2 });
  assert.equal(seat.hallId, 1);
  assert.equal(seat.label, 'A1');
});

test('nextFreeSeat returns null when every hall is full', () => {
  const taken = new Set(allSeats.map((s) => s.id));
  assert.equal(nextFreeSeat({ halls: [hallA, hallB], seats: allSeats, takenSeatIds: taken, spacing: false, preferHallId: 1 }), null);
});
