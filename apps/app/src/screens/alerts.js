import React from 'react';
import { api } from '../api';
import { FormSheet } from '../FormSheet';
import { useNav } from '../nav';
import { addDays, dateTimeIn, todayIn } from '../vtime';

/** "Tell me when a slot opens" sheet. If something matching is free right now, say so and offer to book it. */
export function AlertSheet({ venue, visible, onClose, date, resourceId, onDone }) {
  const { push } = useNav();
  const tz = venue.timezone ?? 'UTC';
  const start = date ?? addDays(todayIn(tz), 1);
  return (
    <FormSheet visible={visible} onClose={onClose} title={`Alert me · ${venue.name}`} submitLabel="Notify me" initial={{ date_from: start, date_to: start, resource_id: resourceId ?? '' }}
      fields={[
        { key: 'resource_id', label: 'Which court', type: 'choice', options: [{ value: '', label: 'Any court' }, ...(venue.resources ?? []).filter((r) => r.kind !== 'equipment').map((r) => ({ value: r.id, label: r.name }))] },
        { key: 'date_from', label: 'From date', type: 'date', min: todayIn(tz) }, { key: 'date_to', label: 'Until date', type: 'date', min: todayIn(tz) },
        { key: 'from_time', label: 'Earliest start', type: 'time', optional: true }, { key: 'to_time', label: 'Latest finish', type: 'time', optional: true },
        { key: 'slots', label: 'Slots in a row', type: 'number', optional: true, hint: 'e.g. 2 for a two-hour session' },
      ]}
      onSubmit={async (f) => {
        const r = await api.post('/slot-alerts', { venue_id: venue.id, ...f, resource_id: f.resource_id || undefined });
        onDone?.();
        if (!r.created) {
          setTimeout(() => push('BookFlow', { venueId: venue.id, resourceId: r.available_now.resource_id, date: r.available_now.date }), 0);
          return `Good news — ${r.available_now.resource_name} is free ${dateTimeIn(r.available_now.starts_at, tz)}. Opening it…`;
        }
        return "We'll tell you the moment a slot opens 🔔";
      }} />
  );
}
