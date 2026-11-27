// Halls page (owner: Mohamed Rishi).
// Admin: create, search, edit/resize (with impact preview), block/reopen seats
// (with impact preview), delete, export to S3. Proctor: search + view grids.
// All data goes into the DOM through ESP.el/textContent (never innerHTML).
// Hiding controls is only for usability; the API enforces every role check.
(async () => {
  const { el } = ESP;
  const $ = (id) => document.getElementById(id);
  const user = await ESP.initPage({ roles: ['admin', 'proctor'] });
  const isAdmin = user.role === 'admin';
  let current = null; // the hall that is open
  let selectedSeat = null;

  if (isAdmin) {
    $('new-btn').classList.remove('hidden');
    $('new-btn').addEventListener('click', () => $('create-card').classList.toggle('hidden'));
    document.querySelectorAll('.admin-only').forEach((n) => n.classList.remove('hidden'));
  } else {
    $('page-sub').textContent = 'Read-only view of exam halls and their seat grids.';
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const num = (id) => Number($(id).value);

  // ---------- create ----------
  function createPreview() {
    const r = num('c-rows'); const c = num('c-cols');
    $('c-preview').textContent = Number.isInteger(r) && Number.isInteger(c) && r >= 1 && r <= 40 && c >= 1 && c <= 40
      ? `This creates ${r * c} seats (A1 … ${rowLetter(r)}${c}).` : 'Rows and columns must be whole numbers from 1 to 40.';
  }
  function rowLetter(r) { return r <= 26 ? String.fromCharCode(64 + r) : `A${String.fromCharCode(64 + r - 26)}`; }
  ['c-rows', 'c-cols'].forEach((id) => $(id).addEventListener('input', createPreview));
  createPreview();

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('create-msg').replaceChildren();
    try {
      const { hall } = await ESP.api('/halls', { method: 'POST', body: { name: $('c-name').value.trim(), building: $('c-building').value.trim(), rows: num('c-rows'), cols: num('c-cols') } });
      ESP.toast(`Hall ${hall.name} created with ${hall.total_seats} seats`);
      e.target.reset(); createPreview();
      $('create-card').classList.add('hidden');
      await load();
      openHall(hall.id);
    } catch (err) { ESP.showError($('create-msg'), err); }
  });

  // ---------- list / search ----------
  async function load() {
    $('list-msg').replaceChildren();
    const spacing = $('q-spacing').checked;
    try {
      const { halls } = await ESP.api('/halls', { query: { name: $('q-name').value.trim(), building: $('q-building').value.trim(), minCapacity: $('q-min').value, spacing: spacing ? 'true' : undefined } });
      $('rows').replaceChildren(...(halls.length ? halls.map((h) => el('tr', {},
        el('td', {}, el('strong', {}, h.name)), el('td', {}, h.building), el('td', {}, `${h.rows} × ${h.cols}`),
        el('td', {}, `${h.usable_seats} / ${h.total_seats}`), el('td', {}, h.spaced_seats),
        el('td', {}, el('button', { type: 'button', class: 'ghost', onclick: () => openHall(h.id) }, 'Open →'))))
        : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No halls match these filters.'))]));
    } catch (err) { ESP.showError($('list-msg'), err); }
  }
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });

  // ---------- one hall ----------
  async function openHall(id, { keepMsg = false } = {}) {
    if (!keepMsg) $('hall-msg').replaceChildren();
    $('seat-panel').replaceChildren();
    selectedSeat = null;
    try {
      const { hall } = await ESP.api(`/halls/${id}`);
      showHall(hall);
      history.replaceState(null, '', `halls.html?id=${hall.id}`);
    } catch (err) {
      $('hall-card').classList.remove('hidden');
      ESP.showError($('hall-msg'), err);
    }
  }

  function showHall(hall) {
    current = hall;
    $('hall-card').classList.remove('hidden');
    $('hall-title').textContent = `${hall.name} — ${hall.building}`;
    const blocked = hall.seats.filter((s) => s.status === 'blocked').map((s) => s.label);
    $('hall-summary').textContent = `${hall.rows} rows × ${hall.cols} columns · ${hall.usable_seats} of ${hall.total_seats} seats usable · ${hall.spaced_seats} with spacing`
      + (blocked.length ? ` · blocked: ${blocked.join(', ')}` : '');
    const grid = $('seat-grid');
    grid.style.gridTemplateColumns = `repeat(${hall.cols}, minmax(3rem, 1fr))`;
    grid.replaceChildren(...hall.seats.map((s) => {
      const attrs = { class: `seat ${s.status === 'blocked' ? 'blocked' : ''}`, title: s.blockReason || s.label, dataset: { seatId: s.id, label: s.label } };
      const body = [el('strong', {}, s.label), el('div', {}, s.status === 'blocked' ? 'blocked' : '')];
      return isAdmin ? el('button', { type: 'button', ...attrs, 'aria-label': `Seat ${s.label}, ${s.status}`, onclick: () => selectSeat(s) }, body) : el('div', attrs, body);
    }));
    $('edit-form').classList.add('hidden');
    $('hall-title').focus();
  }

  // ---------- seat block / reopen with impact preview ----------
  async function selectSeat(seat) {
    selectedSeat = seat;
    document.querySelectorAll('#seat-grid .seat').forEach((n) => n.classList.toggle('selected', Number(n.dataset.seatId) === seat.id));
    const panel = $('seat-panel');
    panel.replaceChildren(el('p', { class: 'muted' }, `Checking seat ${seat.label}…`));
    if (seat.status === 'blocked') {
      panel.replaceChildren(el('div', { class: 'impact' },
        el('p', {}, `Seat ${seat.label} is blocked${seat.blockReason ? ` (${seat.blockReason})` : ''}. Reopening adds one usable seat.`),
        el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => saveSeat(seat, 'available') }, `Reopen ${seat.label}`),
          el('button', { type: 'button', class: 'secondary', onclick: () => panel.replaceChildren() }, 'Cancel'))));
      return;
    }
    try {
      const impact = await ESP.api(`/halls/${current.id}/seats/${seat.id}/impact`);
      const reason = el('input', { id: 'block-reason', maxlength: 120, placeholder: 'e.g. Broken chair' });
      const lines = impact.affected.map((e) => el('li', {},
        `${e.courseCode} on ${ESP.fmtDate(e.examDate)} ${e.startTime} (${e.planStatus}): ${e.students.map((s) => `${s.studentCode} ${s.name}`).join(', ')} — `,
        el('strong', {}, {
          student_relocated: `student will be moved to a free seat (${e.freeSeats} free)`,
          draft_needs_reallocation: 'draft plan will need to be re-run',
          refused_no_capacity: 'REFUSED: no free seat to move the student to',
        }[e.outcome])));
      panel.replaceChildren(el('div', { class: `impact ${impact.allowed ? '' : 'bad'}` },
        el('p', {}, el('strong', {}, `Block seat ${seat.label}?`), ' ',
          impact.affected.length ? `This affects ${plural(impact.affected.length, 'exam')}:` : 'No exam uses this seat. Usable seats go down by one.'),
        impact.affected.length ? el('ul', {}, lines) : null,
        el('div', { class: 'field' }, el('label', { for: 'block-reason' }, 'Reason (optional)'), reason),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'danger', disabled: !impact.allowed, onclick: () => saveSeat(seat, 'blocked', reason.value.trim()) }, `Block ${seat.label}`),
          el('button', { type: 'button', class: 'secondary', onclick: () => panel.replaceChildren() }, 'Cancel'))));
    } catch (err) { ESP.showError(panel, err); }
  }

  async function saveSeat(seat, status, reason) {
    try {
      const r = await ESP.api(`/halls/${current.id}/seats/${seat.id}`, { method: 'PATCH', body: { status, ...(reason ? { reason } : {}) } });
      ESP.toast(`Seat ${seat.label} ${status === 'blocked' ? 'blocked' : 'reopened'}. ${r.hall.usable_seats} usable seats.`);
      showHall(r.hall);
      $('seat-panel').replaceChildren();
      load();
    } catch (err) { ESP.showError($('seat-panel'), err); }
  }

  // ---------- edit / resize with impact preview ----------
  let previewFor = null; // "rows x cols" the admin has seen the impact for
  $('edit-btn').addEventListener('click', () => {
    $('e-name').value = current.name; $('e-building').value = current.building;
    $('e-rows').value = current.rows; $('e-cols').value = current.cols;
    $('resize-impact').replaceChildren(); previewFor = null;
    $('edit-form').classList.remove('hidden');
    $('save-edit').textContent = 'Save changes';
  });
  $('cancel-edit').addEventListener('click', () => $('edit-form').classList.add('hidden'));
  ['e-rows', 'e-cols'].forEach((id) => $(id).addEventListener('input', () => { previewFor = null; $('resize-impact').replaceChildren(); $('save-edit').textContent = 'Save changes'; }));

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = num('e-rows'); const cols = num('e-cols');
    const resizing = rows !== current.rows || cols !== current.cols;
    const key = `${rows}x${cols}`;
    if (resizing && previewFor !== key) {
      // Step 1: show the impact first; the admin confirms with a second click.
      try {
        const im = await ESP.api(`/halls/${current.id}/resize-impact`, { query: { rows, cols } });
        const box = el('div', { class: `impact ${im.allowed ? '' : 'bad'}` },
          el('p', {}, el('strong', {}, `Resize ${im.from.rows}×${im.from.cols} → ${im.to.rows}×${im.to.cols}: `),
            `removes ${plural(im.removedSeats.length, 'seat')}${im.removedSeats.length ? ` (${im.removedSeats.slice(0, 12).map((s) => s.label).join(', ')}${im.removedSeats.length > 12 ? '…' : ''})` : ''}, adds ${plural(im.addedSeats, 'seat')}. `,
            `Usable seats ${im.capacityBefore.usableSeats} → ${im.capacityAfter.usableSeats}.`),
          im.blockedBy.length ? el('p', {}, el('strong', {}, 'Refused: '), `published plans use removed seats — ${im.blockedBy.map((x) => `${x.courseCode} (${x.students.map((s) => s.seatLabel).join(', ')})`).join('; ')}`) : null,
          im.draftsInvalidated.length ? el('p', {}, `Draft plans that will need re-running: ${im.draftsInvalidated.map((x) => x.courseCode).join(', ')}`) : null);
        $('resize-impact').replaceChildren(box);
        if (im.allowed) { previewFor = key; $('save-edit').textContent = 'Confirm resize'; }
      } catch (err) { ESP.showError($('resize-impact'), err); }
      return;
    }
    try {
      const body = { name: $('e-name').value.trim(), building: $('e-building').value.trim() };
      if (resizing) Object.assign(body, { rows, cols });
      const r = await ESP.api(`/halls/${current.id}`, { method: 'PUT', body });
      ESP.toast(resizing ? `Hall resized: ${r.removedSeatIds.length} seats removed, ${r.addedSeats} added` : 'Hall details saved');
      showHall(r.hall);
      load();
    } catch (err) { ESP.showError($('resize-impact'), err); }
  });

  // ---------- delete ----------
  $('delete-btn').addEventListener('click', async () => {
    if (!window.confirm(`Delete ${current.name} and all ${current.total_seats} seats? This cannot be undone. Halls used by an exam cannot be deleted.`)) return;
    try {
      await ESP.api(`/halls/${current.id}`, { method: 'DELETE' });
      ESP.toast(`${current.name} deleted`);
      current = null;
      $('hall-card').classList.add('hidden');
      history.replaceState(null, '', 'halls.html');
      load();
    } catch (err) { ESP.showError($('hall-msg'), err); }
  });

  // ---------- S3 export ----------
  $('export-btn').addEventListener('click', async () => {
    try {
      const r = await ESP.api(`/halls/${current.id}/export`, { method: 'POST', body: {} });
      $('hall-msg').replaceChildren(el('div', { class: 'alert ok' }, `Layout exported to S3 bucket ${r.files[0].bucket}: `,
        ...r.files.map((f, i) => [i ? ', ' : '', el('code', {}, f.key)])));
    } catch (err) { ESP.showError($('hall-msg'), err); }
  });

  // ---------- availability ----------
  $('a-date').value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  $('avail-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('avail-out');
    try {
      const r = await ESP.api('/halls/available', { query: { date: $('a-date').value, start: $('a-start').value, duration: $('a-duration').value } });
      out.replaceChildren(
        el('p', {}, `${plural(r.halls.length, 'hall')} free on ${ESP.fmtDate(r.slot.date)} from ${r.slot.start} for ${r.slot.duration} min (15-min turnover included).`),
        el('ul', {}, r.halls.map((h) => el('li', {}, `${h.name} (${h.building}) · ${h.usable_seats} usable seats`))),
        r.booked.length ? el('p', { class: 'muted small' }, `Booked: ${r.booked.map((b) => `${b.name} (${b.bookedBy})`).join('; ')}`) : null);
    } catch (err) { ESP.showError(out, err); }
  });

  await load();
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (id) openHall(id);
})();
