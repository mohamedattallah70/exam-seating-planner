// Seat map page (owner: Mohamed Attallah).
// Without ?exam&hall: the proctor's list of assigned halls.
// With them: printable grid + attendance list. Admin: any hall of the exam;
// proctor: only an assigned hall of a published plan (enforced by the API).
(async () => {
  const { el } = ESP;
  const user = await ESP.initPage({ roles: ['admin', 'proctor'] });
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const examId = Number(q.get('exam')); const hallId = Number(q.get('hall'));

  if (!examId || !hallId) {
    if (user.role === 'admin') { location.href = 'allocation.html'; return; }
    $('list-card').classList.remove('hidden');
    try {
      const { halls } = await ESP.api('/me/proctor-halls');
      $('hall-rows').replaceChildren(...(halls.length ? halls.map((h) => el('tr', {},
        el('td', {}, `${h.course_code} — ${h.title}`), el('td', {}, `${ESP.fmtDate(h.exam_date)} ${h.start_time}`),
        el('td', {}, `${h.hall} (${h.building})`),
        el('td', {}, h.seatMapReady ? el('a', { href: `seat-map.html?exam=${h.examId}&hall=${h.hallId}` }, 'Open / print') : el('span', { class: 'muted' }, 'Not published yet'))))
        : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'You have no upcoming hall assignments.'))]));
    } catch (err) { ESP.showError($('page-msg'), err); }
    return;
  }

  try {
    const { exam, hall, seats, seatsUsed } = await ESP.api(`/exams/${examId}/halls/${hallId}/seat-map`);
    document.title = `${exam.course_code} ${hall.name} · Seat map`;
    $('map-title').textContent = `${exam.course_code} — ${hall.name}`;
    $('map-details').textContent = `${exam.title} · ${ESP.fmtDate(exam.exam_date)} at ${exam.start_time} · ${hall.building} · ${seatsUsed} students · plan: ${exam.allocation_status}`;
    const grid = $('seat-grid');
    grid.style.gridTemplateColumns = `repeat(${hall.cols}, minmax(3.6rem, 1fr))`;
    grid.replaceChildren(...seats.map((s) => el('div', { class: `seat ${s.status === 'blocked' ? 'blocked' : s.studentCode ? 'taken' : ''}`, title: s.studentName || '' },
      el('strong', {}, s.label), el('div', {}, s.status === 'blocked' ? 'blocked' : s.studentCode || ''))));
    $('list-rows').replaceChildren(...seats.filter((s) => s.studentCode).sort((a, b) => a.studentCode.localeCompare(b.studentCode))
      .map((s) => el('tr', {}, el('td', {}, s.studentCode), el('td', {}, s.studentName), el('td', {}, s.label), el('td', {}, ''))));
    $('map-card').classList.remove('hidden'); $('att-card').classList.remove('hidden');
  } catch (err) { ESP.showError($('page-msg'), err); }
  $('print').addEventListener('click', () => window.print());
})();
