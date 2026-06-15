import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSlashIndex, listSkillsFromRoots, parseFrontmatter } from '../src/slashIndex.js';

test('parseFrontmatter reads quoted skill metadata', () => {
  const parsed = parseFrontmatter('---\nname: ccdawn-brt\ndescription: "中文说明"\n---\n# Body');
  assert.equal(parsed.name, 'ccdawn-brt');
  assert.equal(parsed.description, '中文说明');
});

test('listSkillsFromRoots indexes SKILL.md files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-skills-'));
  const skillDir = path.join(root, 'ccdawn-brt');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: ccdawn-brt',
    'description: "BRT workflow 中文优先"',
    '---',
    '# BRT'
  ].join('\n'));

  const skills = await listSkillsFromRoots([root]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].type, 'skill');
  assert.equal(skills[0].name, 'ccdawn-brt');
  assert.equal(skills[0].insertText, '$ccdawn-brt');
  assert.match(skills[0].description, /中文优先/);
});

test('buildSlashIndex merges commands and skills', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-index-'));
  await fs.mkdir(path.join(root, 'code'), { recursive: true });
  await fs.writeFile(path.join(root, 'code', 'SKILL.md'), '---\nname: Code\ndescription: Coding workflow\n---\n');

  const index = await buildSlashIndex({ skillRoots: [root] });
  assert.ok(index.commands.some((item) => item.name === '/new'));
  assert.ok(index.skills.some((item) => item.name === 'Code'));
  assert.ok(index.items.some((item) => item.insertText === '$Code'));
});
