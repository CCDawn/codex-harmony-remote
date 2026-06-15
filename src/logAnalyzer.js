import fs from 'node:fs/promises';
import path from 'node:path';

const IMPORTANT_EVENT = /failed|failure|error|denied|timeout|stderr/i;

export async function analyzeLogRun(logDir) {
  const meta = await readJson(path.join(logDir, 'meta.json'));
  const entries = await readJsonl(path.join(logDir, 'all.jsonl'));
  const files = await listLogFiles(logDir);

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
    health: classifyHealth(entries),
    latest: entries.slice(-10),
    important: latestImportant(entries),
    bridge: summarizeBridge(entries),
    app: summarizeSource(entries, 'harmony-app'),
    task: summarizeTasks(entries),
    files
  };

  await fs.writeFile(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(logDir, 'summary.md'), renderMarkdown(summary), 'utf8');
  return summary;
}

function classifyHealth(entries) {
  const errors = entries.filter((entry) => entry.level === 'error' || IMPORTANT_EVENT.test(entry.event));
  const httpFailures = entries.filter((entry) => {
    return entry.event === 'http.request.completed' && Number(entry.data?.statusCode ?? 0) >= 400;
  });
  const appEntries = entries.filter((entry) => entry.source === 'harmony-app');

  if (errors.length > 0 || httpFailures.length > 0) {
    return {
      status: 'needs_attention',
      reason: `${errors.length} important/error event(s), ${httpFailures.length} HTTP failure(s)`
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
