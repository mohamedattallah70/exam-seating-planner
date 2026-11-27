// Exam detail page: edit/reschedule, delete, proctors, roster import (paste or
// CSV -> S3 presigned upload), roster search/remove, import history.
(async () => {
  const { el } = ESP;
  const user = await ESP.initPage({ roles: ['admin', 'proctor'] });
  const isAdmin = user.role === 'admin';
  const examId = Number(new URLSearchParams(location.search).get('id'));
  const STATUS = { none: 'Not allocated', draft: 'Draft', published: 'Published', needs_reallocation: 'Needs reallocation' };
  if (isAdmin) document.querySelectorAll('.admin-only').forEach((n) => n.classList.remove('hidden'));
  let exam;

  async function loadExam() {
    try {
      ({ exam } = await ESP.api(`/exams/${examId}`));
    } catch (err) {
      ESP.showError(document.getElementById('page-msg'), err);
      document.querySelectorAll('section, .page-head').forEach((n) => n.classList.add('hidden'));
      return false;
    }
    document.title = `${exam.course_code} · Exam Seating Planner`;
    document.getElementById('title').replaceChildren(`${exam.course_code} — ${exam.title} `, el('span', { class: `badge ${exam.allocation_status}` }, STATUS[exam.allocation_status]));
    document.getElementById('when').textContent = `${ESP.fmtDate(exam.exam_date)} · ${exam.start_time}–${exam.end_time} (${exam.duration_min} min)`;
    const notes = [];
    if (exam.holiday_note) notes.push(el('div', { class: 'alert warn' }, exam.holiday_note));
    if (exam.enrolled > exam.capacity) notes.push(el('div', { class: 'alert error' }, `Roster (${exam.enrolled}) exceeds usable seats (${exam.capacity}). Add a hall before allocating.`));
    if (exam.allocation_status === 'needs_reallocation') notes.push(el('div', { class: 'alert warn' }, 'A change made the seating plan invalid — it must be re-allocated.'));
    document.getElementById('notes').replaceChildren(...notes);
    renderHalls();
    return true;
  }

  function renderHalls() {
    const byHall = (id) => exam.proctors.filter((p) => p.hall_id === id);
    document.getElementById('halls').replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Hall'), el('th', {}, 'Usable seats'), el('th', {}, 'Proctors'))),
      el('tbody', {}, exam.halls.map((h) => el('tr', {},
        el('td', {}, `${h.name} (${h.building})`),
        el('td', {}, h.usable_seats),
        el('td', {}, byHall(h.id).length ? byHall(h.id).map((p) => el('div', {}, p.proctor_name,
          isAdmin ? el('button', { type: 'button', class: 'ghost', title: 'Remove', onclick: () => removeProctor(p) }, '✕') : null)) : el('span', { class: 'muted' }, 'none'))))))));
    document.getElementById('p-hall').replaceChildren(...exam.halls.map((h) => el('option', { value: h.id }, h.name)));
  }

  async function removeProctor(p) {
    if (!confirm(`Remove ${p.proctor_name} from ${p.hall_name}?`)) return;
    try { await ESP.api(`/exams/${examId}/proctors/${p.id}`, { method: 'DELETE' }); ESP.toast('Proctor removed'); await loadExam(); } catch (err) { ESP.toast(err.message, 'error'); }
  }

  async function loadRoster() {
    try {
      const { students } = await ESP.api(`/exams/${examId}/students`, { query: { search: document.getElementById('roster-search').value.trim() } });
      document.getElementById('roster-title').textContent = `Roster (${exam.enrolled} students · ${exam.capacity} usable seats)`;
      document.getElementById('roster').replaceChildren(...(students.length ? students.map((s) => el('tr', {},
        el('td', {}, s.student_code), el('td', {}, s.name), el('td', {}, ESP.fmtDate(s.enrolled_at)),
        isAdmin ? el('td', {}, el('button', { type: 'button', class: 'ghost', onclick: () => unenrol(s) }, 'Remove')) : null)) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No students enrolled yet.'))]));
    } catch (err) { ESP.toast(err.message, 'error'); }
  }

  async function unenrol(s) {
    if (!confirm(`Remove ${s.student_code} from this exam?`)) return;
    try { await ESP.api(`/exams/${examId}/students/${s.student_id}`, { method: 'DELETE' }); ESP.toast(`${s.student_code} removed`); await loadExam(); await loadRoster(); } catch (err) { ESP.toast(err.message, 'error'); }
  }

  async function loadImports() {
    if (!isAdmin) return;
    const { imports } = await ESP.api(`/exams/${examId}/imports`);
    document.getElementById('imports').replaceChildren(...(imports.length ? imports.map((i) => el('tr', {},
      el('td', {}, new Date(i.created_at).toLocaleString('en-GB')), el('td', {}, i.source === 's3' ? 'CSV (S3)' : 'Pasted'),
      el('td', {}, i.accepted), el('td', {}, i.rejected), el('td', {}, i.imported_by || ''))) : [el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'No imports yet.'))]));
  }

  function showReport(report, error) {
    const box = document.getElementById('import-report');
    const rejected = report?.rejected || error?.details || [];
    box.replaceChildren(
      el('div', { class: `alert ${report?.accepted ? 'ok' : 'error'}` }, report?.accepted ? `${report.accepted} student(s) added. Roster now has ${report.enrolled}.` : (error?.message || 'No students added')),
      ...(report?.warnings || []).map((w) => el('div', { class: 'alert warn' }, w)),
      rejected.length ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Row'), el('th', {}, 'Value'), el('th', {}, 'Reason'), el('th', {}, 'Detail'))),
        el('tbody', {}, rejected.map((r) => el('tr', {}, el('td', {}, r.row), el('td', {}, r.value), el('td', {}, el('span', { class: 'badge danger' }, r.reason)), el('td', {}, r.message)))))) : null);
  }

  // ----- admin actions -----
  if (isAdmin) {
    document.getElementById('edit-btn').addEventListener('click', () => {
      const card = document.getElementById('edit-card');
      card.classList.toggle('hidden');
      document.getElementById('edit-form').replaceChildren(ESP.examForm({ exam, onSaved: async ({ warnings }) => {
        ESP.toast('Exam updated');
        warnings.forEach((w) => ESP.toast(w, 'warn'));
        card.classList.add('hidden');
        await loadExam();
      } }));
    });

    document.getElementById('delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete ${exam.course_code}? Its roster and draft seating plan will also be removed.`)) return;
      try { await ESP.api(`/exams/${examId}`, { method: 'DELETE' }); location.href = 'exams.html'; } catch (err) { ESP.showError(document.getElementById('page-msg'), err); }
    });

    const { users } = await ESP.api('/users', { query: { role: 'proctor' } });
    document.getElementById('p-user').replaceChildren(...users.map((u) => el('option', { value: u.id }, u.name)));
    document.getElementById('proctor-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('proctor-msg');
      msg.replaceChildren();
      try {
        await ESP.api(`/exams/${examId}/proctors`, { method: 'POST', body: { hallId: Number(document.getElementById('p-hall').value), proctorId: Number(document.getElementById('p-user').value) } });
        ESP.toast('Proctor assigned');
        await loadExam();
      } catch (err) { ESP.showError(msg, err); }
    });

    document.getElementById('import-btn').addEventListener('click', async (e) => {
      const btn = e.target;
      const file = document.getElementById('csv').files[0];
      const codes = document.getElementById('paste').value.trim();
      if (!file && !codes) return ESP.toast('Paste codes or choose a CSV file first', 'warn');
      btn.disabled = true;
      try {
        let body = { codes };
        if (file) {
          if (file.size > 200 * 1024) throw new ESP.ApiError(400, { message: 'CSV must be under 200 KB' });
          const { key, url } = await ESP.api(`/exams/${examId}/students/upload-url`, { method: 'POST' });
          const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: file });
          if (!put.ok) throw new ESP.ApiError(put.status, { message: 'Upload to S3 failed' });
          body = { s3Key: key };
        }
        const report = await ESP.api(`/exams/${examId}/students`, { method: 'POST', body });
        showReport(report);
        document.getElementById('paste').value = '';
        document.getElementById('csv').value = '';
      } catch (err) {
        showReport(null, err);
      } finally {
        btn.disabled = false;
        await loadExam(); await loadRoster(); await loadImports();
      }
    });
  }

  let t;
  document.getElementById('roster-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadRoster, 300); });
  if (await loadExam()) { await loadRoster(); await loadImports(); }
})();
