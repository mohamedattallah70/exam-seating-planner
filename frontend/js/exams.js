// Exams list page: search/filter (admin + proctor) and create (admin).
(async () => {
  const { el } = ESP;
  const user = await ESP.initPage({ roles: ['admin', 'proctor'] });
  const STATUS = { none: 'Not allocated', draft: 'Draft', published: 'Published', needs_reallocation: 'Needs reallocation' };

  if (user.role === 'proctor') {
    document.getElementById('page-title').textContent = 'My exams';
    document.getElementById('page-sub').textContent = 'Exams and halls you are assigned to supervise.';
  } else {
    const card = document.getElementById('create-card');
    const btn = document.getElementById('new-btn');
    btn.classList.remove('hidden');
    btn.addEventListener('click', () => card.classList.toggle('hidden'));
    document.getElementById('create-form').append(ESP.examForm({
      onSaved: ({ exam, warnings }) => {
        ESP.toast(`Exam ${exam.course_code} created`);
        warnings.forEach((w) => ESP.toast(w, 'warn'));
        location.href = `exam.html?id=${exam.id}`;
      },
    }));
  }

  async function load() {
    const msg = document.getElementById('list-msg');
    msg.replaceChildren();
    try {
      const { exams } = await ESP.api('/exams', { query: {
        course: document.getElementById('q-course').value.trim(),
        from: document.getElementById('q-from').value,
        to: document.getElementById('q-to').value,
        status: document.getElementById('q-status').value,
      } });
      const rows = exams.map((x) => {
        const capacity = x.halls.reduce((n, h) => n + h.usable_seats, 0);
        return el('tr', {},
          el('td', {}, el('strong', {}, x.course_code), el('div', { class: 'muted small' }, x.title)),
          el('td', {}, ESP.fmtDate(x.exam_date), x.holiday_note ? el('div', { class: 'badge warn', title: x.holiday_note }, 'holiday') : null),
          el('td', {}, `${x.start_time}–${x.end_time}`),
          el('td', {}, x.halls.map((h) => h.name).join(', ')),
          el('td', {}, `${x.enrolled} / ${capacity}`, x.enrolled > capacity ? el('span', { class: 'badge danger' }, 'over') : null),
          el('td', {}, el('span', { class: `badge ${x.allocation_status}` }, STATUS[x.allocation_status])),
          el('td', {}, el('a', { href: `exam.html?id=${x.id}` }, 'Open →')));
      });
      document.getElementById('rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No exams found.'))]));
    } catch (err) { ESP.showError(msg, err); }
  }

  document.getElementById('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
})();
