import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BUILTIN_SLASH_COMMANDS = [
  { id: 'cmd:help', type: 'command', name: '/help', insertText: '/help', title: '帮助', description: '显示所有可用斜杠指令' },
  { id: 'cmd:new', type: 'command', name: '/new', insertText: '/new', title: '新建会话', description: '新建一个 Codex 会话' },
  { id: 'cmd:sessions', type: 'command', name: '/sessions', insertText: '/sessions', title: '会话列表', description: '返回会话列表' },
  { id: 'cmd:refresh', type: 'command', name: '/refresh', insertText: '/refresh', title: '刷新', description: '刷新当前会话和会话列表' },
  { id: 'cmd:status', type: 'command', name: '/status', insertText: '/status', title: '状态', description: '刷新并显示当前链路状态' },
  { id: 'cmd:sync', type: 'command', name: '/sync', insertText: '/sync', title: '同步桌面', description: '请求桌面端切到当前会话' },
  { id: 'cmd:interrupt', type: 'command', name: '/interrupt', insertText: '/interrupt', title: '中断', description: '中断当前正在运行的会话' },
  { id: 'cmd:stop', type: 'command', name: '/stop', insertText: '/stop', title: '停止', description: '中断当前正在运行的会话' },
  { id: 'cmd:approve', type: 'command', name: '/approve', insertText: '/approve', title: '同意', description: '同意当前待确认操作' },
  { id: 'cmd:deny', type: 'command', name: '/deny', insertText: '/deny', title: '拒绝', description: '拒绝当前待确认操作' },
  { id: 'cmd:image', type: 'command', name: '/image', insertText: '/image', title: '图片', description: '选择图片，先放入发送区' },
  { id: 'cmd:clear', type: 'command', name: '/clear', insertText: '/clear', title: '清空', description: '清空输入框和待发送图片' }
];

export async function buildSlashIndex(options = {}) {
  const roots = options.skillRoots ?? defaultSkillRoots();
  const skills = await listSkillsFromRoots(roots);
  return {
    generatedAt: new Date().toISOString(),
    commands: BUILTIN_SLASH_COMMANDS,
    skills,
    items: [...BUILTIN_SLASH_COMMANDS, ...skills]
  };
}

export function defaultSkillRoots(env = process.env) {
  const configured = env.CODEX_BRIDGE_SKILL_ROOTS?.trim();
  if (configured) {
    return configured.split(path.delimiter).map((root) => root.trim()).filter(Boolean);
  }
  return [
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.agents', 'skills')
  ];
}

export async function listSkillsFromRoots(roots) {
  const items = [];
  const seen = new Set();
  for (const root of roots) {
    const skills = await listSkillsFromRoot(root);
    for (const skill of skills) {
      const key = `${skill.name.toLowerCase()}|${skill.path.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(skill);
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listSkillsFromRoot(root) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(root, entry.name, 'SKILL.md');
    const parsed = await readSkillMetadata(skillPath, entry.name, root);
    if (parsed) {
      skills.push(parsed);
    }
  }
  return skills;
}

export async function readSkillMetadata(skillPath, fallbackName = '', root = '') {
  let text = '';
  try {
    text = await fs.readFile(skillPath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(text);
  const name = String(frontmatter.name ?? fallbackName).trim();
  if (!name) {
    return null;
  }
  const description = String(frontmatter.description ?? firstMeaningfulMarkdownLine(text)).trim();
  return {
    id: `skill:${name}`,
    type: 'skill',
    name,
    insertText: `$${name}`,
    title: name,
    description: compactWhitespace(description),
    path: skillPath,
    root
  };
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) {
    return {};
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    return {};
  }
  const body = text.slice(3, end).trim();
  const result = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function firstMeaningfulMarkdownLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('---') && !line.startsWith('#')) ?? '';
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, ' ').slice(0, 240);
}
