import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const readUi = (file: string) =>
  fs.readFileSync(path.join(repoRoot, 'ui', 'components', 'ui', file), 'utf8');

test('shared overlay adapters retain portal and dismissal contracts', () => {
  const dialog = readUi('dialog.tsx');
  const tooltip = readUi('tooltip.tsx');
  const popover = readUi('popover.tsx');
  const menu = readUi('dropdown-menu.tsx');
  assert.match(dialog, /DialogPrimitive\.Portal/);
  assert.match(dialog, /aria-modal|DialogPrimitive\.Content/);
  assert.match(tooltip, /Portal/);
  assert.match(tooltip, /collisionPadding/);
  assert.match(popover, /Portal/);
  assert.match(popover, /collisionPadding/);
  assert.match(menu, /Portal/);
  assert.match(menu, /DropdownMenuPrimitive\.Item/);
});

test('shared form adapters preserve native semantics and keyboard-friendly roles', () => {
  const select = readUi('select.tsx');
  const checkbox = readUi('checkbox.tsx');
  const switchAdapter = readUi('switch.tsx');
  assert.match(select, /<select/);
  assert.match(checkbox, /type="checkbox"/);
  assert.match(checkbox, /indeterminate/);
  assert.match(switchAdapter, /role="switch"/);
});
