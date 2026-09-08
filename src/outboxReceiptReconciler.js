const SESSION_TIMESTAMP_SKEW_MS = 5_000;

export function createOutboxReceiptReconciler({ threadService = null, sessions = null } = {}) {
  return async function reconcileOutboxReceipt(item) {
    const persistedRun = typeof threadService?.findRunBySubmission === 'function'
      ? threadService.findRunBySubmission({
          kind: item.kind,
          threadId: item.threadId,
          projectId: item.projectId,
          submissionId: item.submissionId
        })
      : null;
    if (persistedRun) {
      return {
        status: 'submitted',
        evidence: 'submission_journal',
        result: persistedRun
      };
    }

    if (item.kind !== 'existing_thread'
      || !item.threadId
      || typeof sessions?.getSession !== 'function') {
      return { status: 'unknown', evidence: 'no_receipt' };
    }

    const detail = await sessions.getSession(item.threadId, { tail: 200 }).catch(() => null);
    const attemptAt = Date.parse(String(item.lastAttemptAt ?? item.updatedAt ?? ''));
    const matchingEntry = Array.isArray(detail?.entries)
      ? [...detail.entries].reverse().find((entry) => (
          isUserEntry(entry)
          && String(entry.text ?? '').trim() === String(item.text ?? '').trim()
          && isAtOrAfterAttempt(entry.timestamp, attemptAt)
        ))
      : null;
    if (!matchingEntry) {
      return { status: 'unknown', evidence: 'no_receipt' };
    }

    return {
      status: 'submitted',
      evidence: 'session_user_message',
      result: {
        id: `session-receipt:${item.threadId}:${String(matchingEntry.timestamp ?? '')}`,
        threadId: item.threadId,
        submissionId: item.submissionId,
        observedAt: String(matchingEntry.timestamp ?? '')
      }
    };
  };
}

function isUserEntry(entry) {
  const type = String(entry?.type ?? '').toLowerCase();
  const role = String(entry?.role ?? '').toLowerCase();
  return role === 'user' || type === 'usermessage' || type === 'user_message';
}

function isAtOrAfterAttempt(timestamp, attemptAt) {
  if (!Number.isFinite(attemptAt)) {
    return false;
  }
  const observedAt = Date.parse(String(timestamp ?? ''));
  return Number.isFinite(observedAt) && observedAt >= attemptAt - SESSION_TIMESTAMP_SKEW_MS;
}
