import path from 'node:path';

export function extractCodexProjects(state) {
  const localProjects = readLocalProjects(state);
  const orderedIds = Array.isArray(state?.['project-order'])
    ? state['project-order'].map(String)
    : [];
  const allIds = [...orderedIds];
  for (const id of Object.keys(localProjects)) {
    if (!allIds.includes(id)) {
      allIds.push(id);
    }
  }

  const projects = [];
  const seenRoots = new Set();
  for (const id of allIds) {
    const project = localProjects[id];
    if (!project || typeof project !== 'object') {
      continue;
    }
    const roots = normalizeRootPaths(project.rootPaths ?? project.path ?? project.cwd);
    roots.forEach((root, index) => {
      const rootKey = root.toLowerCase();
      if (seenRoots.has(rootKey)) {
        return;
      }
      seenRoots.add(rootKey);
      const baseName = path.basename(root) || root;
      const name = String(project.name ?? '').trim() || baseName;
      projects.push({
        id: roots.length === 1 ? id : `${id}:${index + 1}`,
        name: roots.length === 1 ? name : `${name} (${baseName})`,
        root
      });
    });
  }
  return projects;
}

export function extractVisibleWorkspaceRoots(state) {
  const projects = extractCodexProjects(state);
  const roots = [
    ...normalizeRootPaths(state?.['electron-saved-workspace-roots']),
    ...projects.map((project) => project.root)
  ];
  const localProjectIds = new Set(Object.keys(readLocalProjects(state)));
  const projectOrder = Array.isArray(state?.['project-order']) ? state['project-order'] : [];
  for (const entry of projectOrder) {
    const value = String(entry ?? '').trim();
    if (!localProjectIds.has(value) && looksLikeWorkspacePath(value)) {
      roots.push(normalizeWorkspaceRoot(value));
    }
  }
  return uniqueRoots(roots);
}

export function extractWorkspaceLabels(state) {
  const labels = {};
  const legacy = state?.['electron-workspace-root-labels'];
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    for (const [root, label] of Object.entries(legacy)) {
      const normalized = normalizeWorkspaceRoot(root);
      if (normalized) {
        labels[normalized] = String(label);
      }
    }
  }
  for (const project of extractCodexProjects(state)) {
    labels[project.root] = project.name;
  }
  return labels;
}

function readLocalProjects(state) {
  const projects = state?.['local-projects'];
  return projects && typeof projects === 'object' && !Array.isArray(projects)
    ? projects
    : {};
}

function normalizeRootPaths(value) {
  const values = Array.isArray(value) ? value : [value];
  return uniqueRoots(values.map(normalizeWorkspaceRoot).filter(Boolean));
}

function uniqueRoots(values) {
  const roots = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeWorkspaceRoot(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

function normalizeWorkspaceRoot(value) {
  return String(value ?? '')
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '');
}

function looksLikeWorkspacePath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(value);
}
