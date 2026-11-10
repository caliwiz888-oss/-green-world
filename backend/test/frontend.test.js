import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('loads the Telegram Mini App bridge before the deferred game module source', () => {
  assert.ok(html.indexOf('telegram-web-app.js') < html.indexOf('id="green-world-module-source"'));
  assert.match(html, /id="green-world-module-source" type="text\/plain"/);
  assert.match(html, /moduleScript\.type="module"/);
  assert.match(html, /button\.addEventListener\("click",\(\)=>\{/);
});

test('frontend authenticates Telegram initData and keeps the access token in memory', () => {
  assert.match(html, /request\('\/api\/auth\/telegram',\{initData\},false\)/);
  assert.match(html, /token=data\.accessToken/);
  assert.match(html, /credentials:'include'/);
});

test('deferred economy actions are not exposed by the frontend', () => {
  // Реальные игровые награды и экономические endpoints отложены до отдельного этапа.
  // Пока интерфейс не должен отправлять вызовы несуществующих игровых API.
  const routes = [...html.matchAll(/action\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(routes, []);
  assert.match(server, /app\.post\('\/api\/auth\/telegram'/);
  assert.match(server, /app\.get\('\/api\/me'/);
});


test('uses a compact sky texture on mobile to limit GPU memory', () => {
  assert.match(html, /skyCanvas\.width=mobile\?1024:4096/);
  assert.match(html, /skyCanvas\.height=mobile\?512:2048/);
  assert.match(html, /skyCtx\.scale\(mobile\?1:4,mobile\?1:4\)/);
});

test('frontend does not persist game state in local storage', () => {
  assert.doesNotMatch(html, /localStorage/);
});

test('creates the approved manor once on the central courtyard axis', () => {
  assert.match(html, /function makeHouse\(\)\s*\{/);
  assert.match(html, /const house=makeHouse\(\);\s*buildingObjects\.push\(house\);/);
  assert.match(html, /g=group\(world,0,0,-12\.442\);g\.name='green-world-manor-full-reference-rebuild';/);
  assert.match(html, /g\.scale\.set\(1\.452,1\.452,1\.452\)/);
});

test('keeps only two symmetric flower beds and symmetric shrub groups', () => {
  assert.match(html, /for\(const \[x,z\] of \[\[-8\.4,7\.2\],\[8\.4,7\.2\]\]\)makeFlowerBed\(x,z\)/);
  assert.match(html, /\[-13\.55,-15\.0,0\],\[13\.55,-15\.0,1\]/);
  assert.match(html, /\[-13\.55,-5\.0,1\],\[13\.55,-5\.0,2\]/);
  assert.match(html, /\[-13\.55,5\.8,2\],\[13\.55,5\.8,0\]/);
});

test('includes the rear pond, three fountains and right-side gazebo', () => {
  assert.match(html, /GREEN_WORLD_Rear_Pond/);
  assert.match(html, /for\(const x of \[-22,0,22\]\)/);
  assert.match(html, /GREEN_WORLD_Rear_Gazebo/);
});
