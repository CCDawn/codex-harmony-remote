export function paginateTaskEvents(events, {
  afterSeq = 0,
  eventLimit = 8,
  cursorRequested = false
} = {}) {
  const normalized = normalizeEvents(events);
  const latestSeq = normalized.at(-1)?.seq ?? 0;
  const requestedSeq = nonNegativeInteger(afterSeq, 0);
  const limit = nonNegativeInteger(eventLimit, 8);
  const earliestSeq = normalized[0]?.seq ?? 1;
  const eventGap = cursorRequested
    && (requestedSeq > latestSeq || (normalized.length > 0 && requestedSeq < earliestSeq - 1));
  const effectiveAfterSeq = eventGap ? 0 : requestedSeq;
  const available = normalized.filter((event) => event.seq > effectiveAfterSeq);
  const selected = limit === 0
    ? []
    : cursorRequested
      ? available.slice(0, limit)
      : available.slice(-limit);
  const eventCursor = selected.at(-1)?.seq ?? effectiveAfterSeq;

  return {
    events: selected,
    eventCursor,
    eventGap,
    hasMoreEvents: eventCursor < latestSeq,
    latestSeq
  };
}

function normalizeEvents(events) {
  return (Array.isArray(events) ? events : []).map((event, index) => ({
    ...event,
    seq: positiveInteger(event?.seq, index + 1)
  }));
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
