// Seat Allocation engine (owner: Mohamed Attallah). Pure functions, no I/O,
// so the rules can be unit-tested and explained exactly.
//
// ALLOCATION RULES (answers the Phase 1 feedback "state the allocation rules")
//   1. Students are seated in student-code order, so the result is repeatable.
//   2. Halls are ordered by usable capacity (largest first), then by name.
//   3. Strategy:
//        fill    - fill hall 1 completely, then hall 2 ... (fewest halls/proctors used)
//        balance - every hall gets a share proportional to its usable capacity
//                  (largest-remainder rounding), so halls are evenly loaded.
//   4. Inside a hall seats are taken row by row (front row A first), left to right.
//   5. Blocked seats are always skipped.
//   6. Spacing: only odd columns (1, 3, 5 ...) are used, so nobody sits side by side.
//   7. Not enough usable seats -> nothing is saved (409 NOT_ENOUGH_SEATS).
//   8. The whole result is saved in ONE transaction (all students seated or none).

const bySeatOrder = (a, b) => a.rowNo - b.rowNo || a.colNo - b.colNo;

// seats: [{ id, hallId, rowNo, colNo, status }] -> usable seats in filling order
function usableSeats(seats, spacing) {
  return seats
    .filter((s) => s.status === 'available' && (!spacing || s.colNo % 2 === 1))
    .sort(bySeatOrder);
}

// halls: [{ id, name }], seats grouped by hall -> halls in rule-2 order with their usable seats
function orderHalls(halls, seats, spacing) {
  return halls
    .map((h) => ({ ...h, usable: usableSeats(seats.filter((s) => s.hallId === h.id), spacing) }))
    .sort((a, b) => b.usable.length - a.usable.length || a.name.localeCompare(b.name));
}

// How many students each hall gets (rule 3).
function quotas(orderedHalls, studentCount, strategy) {
  const caps = orderedHalls.map((h) => h.usable.length);
  if (strategy === 'fill') {
    let left = studentCount;
    return caps.map((c) => { const n = Math.min(c, left); left -= n; return n; });
  }
  const total = caps.reduce((a, b) => a + b, 0);
  const exact = caps.map((c) => (total ? (studentCount * c) / total : 0));
  const q = exact.map(Math.floor);
  let left = studentCount - q.reduce((a, b) => a + b, 0);
  // largest remainder first; ties go to the bigger hall (already first in order)
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left === 0) break; if (q[i] < caps[i]) { q[i] += 1; left -= 1; } }
  return q;
}

// Returns { assignments: [{ studentId, seatId, hallId }], perHall, needed, available }
// or { error: 'NOT_ENOUGH_SEATS', needed, available }.
function plan({ students, halls, seats, strategy = 'fill', spacing = false }) {
  const sorted = [...students].sort((a, b) => a.studentCode.localeCompare(b.studentCode));
  const ordered = orderHalls(halls, seats, spacing);
  const available = ordered.reduce((n, h) => n + h.usable.length, 0);
  if (available < sorted.length) return { error: 'NOT_ENOUGH_SEATS', needed: sorted.length, available };

  const q = quotas(ordered, sorted.length, strategy);
  const assignments = [];
  let next = 0;
  ordered.forEach((h, i) => {
    for (let k = 0; k < q[i]; k += 1) {
      const seat = h.usable[k];
      assignments.push({ studentId: sorted[next].id, seatId: seat.id, hallId: h.id });
      next += 1;
    }
  });
  return {
    assignments,
    needed: sorted.length,
    available,
    perHall: ordered.map((h, i) => ({ hallId: h.id, hall: h.name, order: i + 1, usableSeats: h.usable.length, seatsUsed: q[i] })),
  };
}

// Next free seat for one student (used by the event worker when a seat is
// blocked or a student is added to a published plan). preferHallId first,
// then the exam's other halls in rule-2 order.
function nextFreeSeat({ halls, seats, takenSeatIds, spacing, preferHallId }) {
  const ordered = orderHalls(halls, seats, spacing);
  ordered.sort((a, b) => (b.id === preferHallId) - (a.id === preferHallId));
  for (const h of ordered) {
    const seat = h.usable.find((s) => !takenSeatIds.has(s.id));
    if (seat) return { ...seat, hallId: h.id };
  }
  return null;
}

module.exports = { usableSeats, orderHalls, quotas, plan, nextFreeSeat };
