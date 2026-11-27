// Shared create / edit exam form (Exam & Enrolment service).
// - Live holiday check (Calendarific via our API) when the date changes.
// - Hall picker shows usable seats and disables halls already booked at that time.
window.ESP = window.ESP || {};

ESP.examForm = function examForm({ exam = null, onSaved }) {
  const { el } = ESP;
  const v = exam || {};
  const msg = el('div');
  const holidayBox = el('div');
  const hallsBox = el('div', { class: 'checkbox-list' }, el('span', { class: 'muted small' }, 'Pick a date and time to see free halls'));
  const input = (name, attrs) => el('input', { name, id: `f-${name}`, required: true, ...attrs });
  const fields = {
    courseCode: input('courseCode', { value: v.course_code || '', placeholder: 'CS301', maxlength: 12, pattern: '[A-Za-z]{2,6}[0-9]{2,4}[A-Za-z]?' }),
    title: input('title', { value: v.title || '', placeholder: 'Cloud Computing', maxlength: 120 }),
    examDate: input('examDate', { type: 'date', value: v.exam_date || '' }),
    startTime: input('startTime', { type: 'time', value: v.start_time || '09:00', min: '08:00', max: '21:30' }),
    durationMin: input('durationMin', { type: 'number', value: v.duration_min || 120, min: 30, max: 300, step: 15 }),
  };
  const selected = new Set((v.halls || []).map((h) => h.id));
  const field = (label, node) => el('div', { class: 'field' }, el('label', { for: node.id }, label), node);

  async function loadHalls() {
    const { examDate, startTime, durationMin } = fields;
    try {
      const { halls } = await ESP.api('/exams/hall-options', { query: { date: examDate.value, start: startTime.value, duration: durationMin.value, excludeExamId: v.id } });
      hallsBox.replaceChildren(...halls.map((h) => {
        const cb = el('input', { type: 'checkbox', value: h.id, checked: selected.has(h.id), disabled: !h.available && !selected.has(h.id),
          onchange: (e) => (e.target.checked ? selected.add(h.id) : selected.delete(h.id)) });
        return el('label', { title: h.available ? '' : `Booked: ${h.booked_by}` }, cb,
          `${h.name} (${h.building}) · ${h.usable_seats} seats`, h.available ? null : el('span', { class: 'badge danger' }, `booked: ${h.booked_by}`));
      }));
    } catch (err) { ESP.showError(hallsBox, err); }
  }

  async function checkHoliday() {
    holidayBox.replaceChildren();
    if (!fields.examDate.value) return;
    try {
      const r = await ESP.api('/holidays/check', { query: { date: fields.examDate.value } });
      if (r.isHoliday) holidayBox.append(el('div', { class: 'alert warn' }, `⚠ ${r.note}`));
      else holidayBox.append(el('div', { class: 'muted small' }, '✓ Not an Egyptian public holiday'));
    } catch (err) {
      holidayBox.append(el('div', { class: 'alert warn' }, err.status === 502 ? 'Holiday service unavailable — you can still save; please check the date manually.' : err.message));
    }
  }

  fields.examDate.addEventListener('change', () => { checkHoliday(); loadHalls(); });
  fields.startTime.addEventListener('change', loadHalls);
  fields.durationMin.addEventListener('change', loadHalls);

  const submit = el('button', { type: 'submit' }, exam ? 'Save changes' : 'Create exam');
  const form = el('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    msg.replaceChildren();
    if (!form.checkValidity() || selected.size === 0) {
      msg.append(el('div', { class: 'alert error' }, 'Fill in every field and choose at least one hall.'));
      return;
    }
    const body = {
      courseCode: fields.courseCode.value.trim(), title: fields.title.value.trim(), examDate: fields.examDate.value,
      startTime: fields.startTime.value, durationMin: Number(fields.durationMin.value), hallIds: [...selected],
    };
    submit.disabled = true;
    try {
      const r = await ESP.api(exam ? `/exams/${exam.id}` : '/exams', { method: exam ? 'PUT' : 'POST', body });
      onSaved(r);
    } catch (err) {
      ESP.showError(msg, err);
      if (err.code === 'HALL_BOOKED') loadHalls();
    } finally { submit.disabled = false; }
  } },
  el('div', { class: 'row' }, field('Course code', fields.courseCode), field('Title', fields.title)),
  el('div', { class: 'row' }, field('Date', fields.examDate), field('Start time', fields.startTime), field('Duration (min)', fields.durationMin)),
  holidayBox,
  el('div', { class: 'field' }, el('label', {}, 'Halls'), hallsBox),
  msg, submit);

  if (v.exam_date) { loadHalls(); checkHoliday(); }
  return form;
};
