import fs from 'node:fs/promises';
import path from 'node:path';

const IMPORTANT_EVENT = /failed|failure|error|denied|timeout|stderr/i;

export async function analyzeLogRun(logDir) {
  const meta = await readJson(path.join(logDir, 'meta.json'));
  const entries = await readJsonl(path.join(logDir, 'all.jsonl'));
  const files = await listLogFiles(logDir);

  const stateSync = summarizeStateSync(entries);
  const summary = {
    generatedAt: new Date().toISOString(),
    logDir,
    run: meta,
    totals: {
      entries: entries.length,
      files: files.length,
      sources: countBy(entries, (entry) => entry.source),
      levels: countBy(entries, (entry) => entry.level),
      events: countBy(entries, (entry) => entry.event)
    },
    health: classifyHealth(entries, stateSync),
    latest: entries.slice(-10),
    important: latestImportant(entries),
    bridge: summarizeBridge(entries),
    app: summarizeSource(entries, 'harmony-app'),
    task: summarizeTasks(entries),
    stateSync,
    files
  };

  await fs.writeFile(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(logDir, 'summary.md'), renderMarkdown(summary), 'utf8');
  return summary;
}

function classifyHealth(entries, stateSync = null) {
  const errors = entries.filter((entry) => entry.level === 'error' || IMPORTANT_EVENT.test(entry.event));
  const httpFailures = entries.filter((entry) => {
    return entry.event === 'http.request.completed' && Number(entry.data?.statusCode ?? 0) >= 400;
  });
  const appEntries = entries.filter((entry) => entry.source === 'harmony-app');

  if (errors.length > 0 || httpFailures.length > 0 || (stateSync?.anomalies?.length ?? 0) > 0) {
    return {
      status: 'needs_attention',
      reason: `${errors.length} important/error event(s), ${httpFailures.length} HTTP failure(s), ${stateSync?.anomalies?.length ?? 0} state-sync anomaly(s)`
    };
  }

  if (entries.length > 0 && appEntries.length === 0) {
    return {
      status: 'waiting_for_phone_logs',
      reason: 'Bridge logs exist, but no phone-side harmony-app logs have arrived yet'
    };
  }

  return {
    status: 'ok',
    reason: 'No important errors detected in the current run'
  };
}

function summarizeStateSync(entries) {
  const interruptEvents = entries.filter((entry) => String(entry.event ?? '').startsWith('codex.turn.interrupt.'));
  const requested = interruptEvents.filter((entry) => entry.event === 'codex.turn.interrupt.requested');
  const confirmed = interruptEvents.filter((entry) => entry.event === 'codex.turn.interrupt.confirmed');
  const failed = interruptEvents.filter((entry) => entry.event === 'codex.turn.interrupt.failed');
  const resolvedInterruptKeys = new Set(
    [...confirmed, ...failed].map(interruptKey).filter(Boolean)
  );
  const unresolved = requested
    .filter((entry) => !resolvedInterruptKeys.has(interruptKey(entry)))
    .map(summarizeCorrelationEntry);

  const blockedEntries = entries.filter((entry) => entry.event === 'submission.blocked_by_interrupt');
  const releasedEntries = entries.filter((entry) => (
    entry.event === 'submission.dequeued'
    && entry.data?.previousReason === 'interrupt_pending'
  ));
  const submittedEntries = entries.filter((entry) => entry.event === 'outbox.item.submitted');
  const releasedKeys = new Set(releasedEntries.map(submissionKey).filter(Boolean));
  const submittedKeys = new Set(submittedEntries.map(submissionKey).filter(Boolean));
  const stuck = blockedEntries
    .filter((entry) => {
      const key = submissionKey(entry);
      return key && !releasedKeys.has(key) && !submittedKeys.has(key);
    })
    .map(summarizeCorrelationEntry);

  const effectivePolicies = entries.filter((entry) => entry.event === 'policy.effective');
  const policyMismatches = entries.filter((entry) => entry.event === 'policy.mismatch');
  const modelCatalogEvents = entries.filter((entry) => (
    entry.event === 'model.catalog.loaded'
    || entry.event === 'session.model_catalog.loaded'
    || entry.event === 'session.model_catalog.refreshed'
  ));
  const runtimeEvents = entries.filter((entry) => entry.event === 'runtime.snapshot.reconciled');
  const runtimeConflicts = runtimeEvents.reduce(
    (total, entry) => total + Number(entry.data?.conflictCount ?? 0),
    0
  );

  const anomalies = [
    ...unresolved.map((entry) => ({
      code: 'interrupt_without_terminal',
      severity: 'warn',
      ...entry
    })),
    ...stuck.map((entry) => ({
      code: 'submission_blocked_without_release',
      severity: 'warn',
      ...entry
    })),
    ...policyMismatches.map((entry) => ({
      code: 'policy_mismatch',
      severity: 'error',
      ...summarizeCorrelationEntry(entry)
    }))
  ];

  return {
    interrupts: {
      requested: requested.length,
      confirmed: confirmed.length,
      failed: failed.length,
      unresolved
    },
    submissions: {
      blockedByInterrupt: blockedEntries.length,
      released: releasedEntries.length,
      submitted: submittedEntries.length,
      stuck
    },
    policy: {
      effective: effectivePolicies.at(-1)?.data ?? null,
      mismatches: policyMismatches.map(summarizeCorrelationEntry)
    },
    modelCatalog: modelCatalogEvents.at(-1)?.data ?? null,
    runtime: {
      reconciliations: runtimeEvents.length,
      conflicts: runtimeConflicts,
      latest: runtimeEvents.at(-1)?.data ?? null
    },
    anomalies
  };
}

function interruptKey(entry) {
  const data = entry?.data ?? {};
  const payload = data.payload ?? {};
  const runId = String(data.runId ?? payload.runId ?? '').trim();
  if (runId) {
    return `run:${runId}`;
  }
  const threadId = String(data.threadId ?? payload.threadId ?? '').trim();
  const turnId = String(data.turnId ?? payload.turnId ?? '').trim();
  return threadId || turnId ? `turn:${threadId}:${turnId}` : '';
}

function submissionKey(entry) {
  const data = entry?.data ?? {};
  const id = String(data.id ?? '').trim();
  if (id) {
    return `outbox:${id}`;
  }
  const submissionId = String(data.submissionId ?? '').trim();
  return submissionId ? `submission:${submissionId}` : '';
}

function summarizeCorrelationEntry(entry) {
  const data = entry?.data ?? {};
  const payload = data.payload ?? {};
  return {
    timestamp: String(entry?.timestamp ?? ''),
    event: String(entry?.event ?? ''),
    runId: String(data.runId ?? payload.runId ?? ''),
    threadId: String(data.threadId ?? payload.threadId ?? ''),
    turnId: String(data.turnId ?? payload.turnId ?? ''),
    submissionId: String(data.submissionId ?? ''),
    outboxId: String(data.id ?? '')
  };
}

function summarizeBridge(entries) {
  const bridgeEntries = entries.filter((entry) => entry.source === 'bridge');
  const requests = bridgeEntries.filter((entry) => entry.event === 'http.request.completed');
  return {
    entries: bridgeEntries.length,
    requests: requests.length,
    failures: bridgeEntries.filter((entry) => {
      return entry.level === 'error' || Number(entry.data?.statusCode ?? 0) >= 400;
    }).slice(-20)
  };
}

function summarizeSource(entries, source) {
  const sourceEntries = entries.filter((entry) => entry.source === source);
  return {
    entries: sourceEntries.length,
    latest: sourceEntries.slice(-20),
    errors: sourceEntries.filter((entry) => entry.level === 'error' || IMPORTANT_EVENT.test(entry.event)).slice(-20)
  };
}

function summarizeTasks(entries) {
  const taskEntries = entries.filter((entry) => entry.source === 'task-events');
  const taskIds = [...new Set(taskEntries.map((entry) => entry.data?.taskId).filter(Boolean))];
  return {
    entries: taskEntries.length,
    taskIds,
    latest: taskEntries.slice(-20),
    failures: taskEntries.filter((entry) => {
      return entry.event === 'task.failed' || entry.event === 'codex.exec.stderr' || entry.event === 'codex.exec.timeout';
    }).slice(-20)
  };
}

async function listLogFiles(logDir) {
  try {
    const items = await fs.readdir(logDir, { withFileTypes: true });
    const files = [];
    for (const item of items) {
      if (!item.isFile()) {
        continue;
      }
      const fullPath = path.join(logDir, item.name);
      const stat = await fs.stat(fullPath);
      files.push({
        name: item.name,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return files.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonl(filePath) {
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({
        timestamp: new Date().toISOString(),
        source: 'analyzer',
        level: 'error',
        event: 'log.parse.failed',
        data: { line }
      });
    }
  }
  return entries;
}

function countBy(entries, getKey) {
  const counts = {};
  for (const entry of entries) {
    const key = String(getKey(entry) ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function latestImportant(entries) {
  return entries.filter((entry) => {
    return entry.level === 'error' || entry.level === 'warn' || IMPORTANT_EVENT.test(entry.event);
  }).slice(-30);
}

function renderMarkdown(summary) {
  const lines = [
    '# Latest Log Summary',
    '',
    `Generated: ${summary.generatedAt}`,
    `Run: ${summary.run?.runId ?? 'unknown'} (${summary.run?.label ?? 'unknown'})`,
    `Health: ${summary.health.status} - ${summary.health.reason}`,
    '',
    '## Totals',
    '',
    `- Entries: ${summary.totals.entries}`,
    `- Sources: ${formatCounts(summary.totals.sources)}`,
    `- Levels: ${formatCounts(summary.totals.levels)}`,
    '',
    '## Important Events',
    ''
  ];

  if (summary.important.length === 0) {
    lines.push('- None');
  } else {
    for (const entry of summary.important) {
      lines.push(`- ${entry.timestamp} [${entry.source}/${entry.level}] ${entry.event}: ${compact(entry.data)}`);
    }
  }

  lines.push('', '## Phone App', '');
  lines.push(`- Entries: ${summary.app.entries}`);
  lines.push(`- Errors: ${summary.app.errors.length}`);

  lines.push('', '## Bridge', '');
  lines.push(`- Entries: ${summary.bridge.entries}`);
  lines.push(`- Requests: ${summary.bridge.requests}`);
  lines.push(`- Failures: ${summary.bridge.failures.length}`);

  lines.push('', '## Tasks', '');
  lines.push(`- Entries: ${summary.task.entries}`);
  lines.push(`- Task IDs: ${summary.task.taskIds.join(', ') || 'none'}`);
  lines.push(`- Failures: ${summary.task.failures.length}`);

  lines.push('', '## State Sync', '');
  lines.push(`- Interrupts: requested=${summary.stateSync.interrupts.requested}, confirmed=${summary.stateSync.interrupts.confirmed}, failed=${summary.stateSync.interrupts.failed}, unresolved=${summary.stateSync.interrupts.unresolved.length}`);
  lines.push(`- Follow-ups: blocked=${summary.stateSync.submissions.blockedByInterrupt}, released=${summary.stateSync.submissions.released}, submitted=${summary.stateSync.submissions.submitted}, stuck=${summary.stateSync.submissions.stuck.length}`);
  lines.push(`- Policy mismatches: ${summary.stateSync.policy.mismatches.length}`);
  lines.push(`- Model catalog: ${summary.stateSync.modelCatalog?.source ?? 'unknown'} (${summary.stateSync.modelCatalog?.modelCount ?? 0} models)`);
  lines.push(`- Runtime conflicts: ${summary.stateSync.runtime.conflicts}`);
  if (summary.stateSync.anomalies.length === 0) {
    lines.push('- Anomalies: none');
  } else {
    for (const anomaly of summary.stateSync.anomalies) {
      lines.push(`- ${anomaly.code}: thread=${anomaly.threadId || 'unknown'}, turn=${anomaly.turnId || 'unknown'}, submission=${anomaly.submissionId || 'unknown'}`);
    }
  }

  lines.push('', '## Files', '');
  for (const file of summary.files) {
    lines.push(`- ${file.name} (${file.bytes} bytes)`);
  }

  return `${lines.join('\n')}\n`;
}

function formatCounts(counts) {
  const parts = Object.entries(counts).map(([key, value]) => `${key}=${value}`);
  return parts.join(', ') || 'none';
}

function compact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) {
    return '';
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
