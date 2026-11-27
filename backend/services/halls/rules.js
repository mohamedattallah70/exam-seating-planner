// Hall & Seat Layout rules (owner: Mohamed Rishi). Pure functions, no I/O,
// so the rules can be unit-tested and explained exactly.
//
//   1. A hall is a grid of rows x cols, each 1..40. Seats are labelled with a
//      row letter + column number (A1, A2 ... B1). Rows after Z continue as
//      AA, AB ... so a 40-row hall still has unique labels.
//   2. Usable capacity = seats that are not blocked.
//   3. Spacing capacity = usable seats in odd columns only (1, 3, 5 ...), the
//      same rule the allocation engine uses for spacing=true.
//   4. A resize keeps every seat whose (row, col) still fits, with its id and
//      blocked status. Seats outside the new grid are removed; new cells are
//      added as available seats.
//   5. Halls have a 15-minute turnover between exams (same rule as the Exam
//      service's hall clash check), so back-to-back bookings count as busy.

const MAX_DIM = 40;
const HALL_TURNOVER_MIN = 15;

function rowLetter(r) {
  return r <= 26 ? String.fromCharCode(64 + r) : `A${String.fromCharCode(64 + r - 26)}`;
}

const seatLabel = (r, c) => `${rowLetter(r)}${c}`;

// Same labelling in SQL (r and c are integer expressions).
const SEAT_LABEL_SQL = (r, c) => `(CASE WHEN ${r} <= 26 THEN chr(64 + ${r}) ELSE 'A' || chr(64 + ${r} - 26) END) || ${c}::text`;

const isUsable = (seat, spacing = false) => seat.status === 'available' && (!spacing || seat.colNo % 2 === 1);

function capacity(seats) {
  return {
    totalSeats: seats.length,
    usableSeats: seats.filter((s) => isUsable(s)).length,
    spacedSeats: seats.filter((s) => isUsable(s, true)).length,
  };
}

// Which existing seats a resize removes, and how many cells it adds.
function resizePlan(seats, oldRows, oldCols, rows, cols) {
  const removed = seats.filter((s) => s.rowNo > rows || s.colNo > cols);
  const kept = seats.filter((s) => s.rowNo <= rows && s.colNo <= cols);
  const added = rows * cols - Math.min(rows, oldRows) * Math.min(cols, oldCols);
  const after = capacity(kept);
  // added cells are always available; count the odd-column ones for spacing
  let addedSpaced = 0;
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      if ((r > oldRows || c > oldCols) && c % 2 === 1) addedSpaced += 1;
    }
  }
  return {
    removed,
    added,
    capacityAfter: {
      totalSeats: rows * cols,
      usableSeats: after.usableSeats + added,
      spacedSeats: after.spacedSeats + addedSpaced,
    },
  };
}

module.exports = { MAX_DIM, HALL_TURNOVER_MIN, rowLetter, seatLabel, SEAT_LABEL_SQL, isUsable, capacity, resizePlan };
