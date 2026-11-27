// Seat Allocation admin page (owner: Mohamed Attallah): overview, run (fill /
// balance, spacing), publish, clear, search and move single students.
(async () => {
  const { el } = ESP;
  await ESP.initPage({ roles: ['admin'] });
  const STATUS = { none: 'Not allocated', draft: 'Draft', published: 'Published', needs_reallocation: 'Needs reallocation' };
  const $ = (id) => document.getElementById(id);
  let examId = Number(new URLSearchParams(location.search).get('exam')) || null;
  let current;

  async function loadOverview() {
    try {
      const { exams } = await ESP.api('/allocations/overview');
      $('exam-rows').replaceChildren(...(exams.length ? exams.map((x) => el('tr', { class: x.id === examId ? 'active' : null },
        el('td', {}, el('strong', {}, x.course_code), el('div', { class: 'muted small' }, x.title)),
        el('td', {}, `${ESP.fmtDate(x.exam_date)} ${x.start_time}`),
        el('td', {}, x.halls), el('td', {}, x.enrolled), el('td', {}, x.seated),
        el('td', {}, el('span', { class: `badge ${x.allocation_status}` }, STATUS[x.allocation_status])),
        el('td', {}, el('button', { type: 'button', class: 'ghost', onclick: () => openExam(x.id) }, 'Manage →'))))
        : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No exams yet.'))]));
    } catch (err) { ESP.showError($('overview-msg'), err); }
  }

  async function openExam(id) {
    examId = id;
    history.replaceState(null, '', `allocation.html?exam=${id}`);
    $('exam-panel').classList.remove('hidden');
    $('action-msg').replaceChildren();
    await loadAllocation();
    $('exam-panel').scrollIntoView({ behavior: 'smooth' });
  }

  async function loadAllocation() {
    try {
      current = await ESP.api(`/exams/${examId}/allocation`, { query: { student: $('search').value.trim(), hallId: $('hall-filter').value } });
    } catch (err) { ESP.showError($('action-msg'), err); return; }
    const { exam, summary, assignments, lastRun } = current;
    $('exam-title').replaceChildren(`${exam.course_code} — ${exam.title} `, el('span', { class: `badge ${exam.allocation_status}` }, STATUS[exam.allocation_status]));
    if (lastRun) { $('strategy').value = lastRun.strategy; $('spacing').checked = lastRun.spacing; }
    const published = exam.allocation_status === 'published';
    $('run').disabled = published; $('clear').disabled = published || exam.allocation_status === 'none';
    $('publish').disabled = exam.allocation_status !== 'draft';
    $('summary-line').textContent = `${ESP.fmtDate(exam.exam_date)} ${exam.start_time} · ${summary.enrolled} enrolled · ${summary.seated} seated · ${summary.unseated} without a seat`
      + (lastRun ? ` · last run: ${lastRun.strategy}${lastRun.spacing ? ' + spacing' : ''} (${lastRun.trigger})` : '');
    $('hall-rows').replaceChildren(...summary.halls.map((h) => el('tr', {},
      el('td', {}, h.order), el('td', {}, h.hall), el('td', {}, h.usableSeats), el('td', {}, h.seatsUsed),
      el('td', {}, el('a', { href: `seat-map.html?exam=${examId}&hall=${h.hallId}` }, 'Open map')))));
    const filter = $('hall-filter'); const keep = filter.value;
    filter.replaceChildren(el('option', { value: '' }, 'All halls'), ...summary.halls.map((h) => el('option', { value: h.hallId }, h.hall)));
    filter.value = keep;
    $('assignment-rows').replaceChildren(...(assignments.length ? assignments.map((a) => {
      const hall = el('select', {}, summary.halls.map((h) => el('option', { value: h.hallId, selected: h.hallId === a.hallId }, h.hall)));
      const seat = el('input', { placeholder: 'C7', maxlength: 4, style: 'width:5rem' });
      return el('tr', {}, el('td', {}, a.studentCode), el('td', {}, a.studentName), el('td', {}, a.hall), el('td', {}, el('strong', {}, a.seat)),
        el('td', {}, el('div', { class: 'row', style: 'gap:.3rem;flex-wrap:nowrap' }, hall, seat,
          el('button', { type: 'button', class: 'ghost', onclick: () => move(a, Number(hall.value), seat.value.trim()) }, 'Move'))));
    }) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No students seated yet. Run the allocation.'))]));
  }

  async function act(fn, okMsg) {
    $('action-msg').replaceChildren();
    try { const r = await fn(); if (okMsg) ESP.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); } catch (err) {
      if (err.code === 'NOT_ENOUGH_SEATS' && err.details) err.message += ` (${err.details.needed} needed, ${err.details.available} available)`;
      ESP.showError($('action-msg'), err);
    }
    await Promise.all([loadAllocation(), loadOverview()]);
  }

  async function move(a, hallId, seatLabel) {
    if (!seatLabel) return ESP.toast('Type a seat label such as C7', 'warn');
    await act(() => ESP.api(`/allocations/${a.assignmentId}`, { method: 'PATCH', body: { hallId, seatLabel } }), (r) => `${r.studentCode} moved to ${r.seat}`);
  }

  $('run').addEventListener('click', () => act(() => ESP.api(`/exams/${examId}/allocation`, { method: 'POST', body: { strategy: $('strategy').value, spacing: $('spacing').checked } }),
    (r) => `${r.studentsSeated} students seated (draft)`));
  $('publish').addEventListener('click', () => { if (confirm('Publish? Students and proctors will see this plan.')) act(() => ESP.api(`/exams/${examId}/allocation/publish`, { method: 'POST' }), 'Published · seat maps exported to S3'); });
  $('clear').addEventListener('click', () => { if (confirm('Clear this draft plan?')) act(() => ESP.api(`/exams/${examId}/allocation`, { method: 'DELETE' }), 'Draft cleared'); });
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); loadAllocation(); });

  await loadOverview();
  if (examId) openExam(examId);
})();
