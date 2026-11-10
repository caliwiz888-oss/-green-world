import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('keeps the 3D module inert until Telegram authentication and starts it automatically', () => {
  assert.match(html, /id="green-world-module-source" type="text\/plain"/);
  assert.match(html, /moduleScript\.type="module"/);
  assert.match(html, /window\.addEventListener\("green-world-auth",startWorld\)/);
  assert.match(html, /if\(window\.GREEN_WORLD_AUTH_RESULT\?\.accessToken\)startWorld\(\)/);
  assert.doesNotMatch(html, /button\.addEventListener\("click",\(\)=>\{if\(!window\.GREEN_WORLD_AUTH_RESULT/);
  assert.ok(html.indexOf('telegram-web-app.js') < html.indexOf('/* Telegram sign-in must not depend'));
});

test('frontend authenticates Telegram initData and keeps the access token in memory', () => {
  assert.match(html, /fetch\(api\+'\/api\/auth\/telegram'/);
  assert.match(html, /body:JSON\.stringify\(\{initData\}\)/);
  assert.match(html, /token=data\.accessToken/);
  assert.match(html, /credentials:'include'/);
  assert.match(html, /window\.dispatchEvent\(new CustomEvent\('green-world-auth'/);
});

test('deferred economy actions are not exposed by the frontend', () => {
  // Реальные игровые награды и экономические endpoints отложены до отдельного этапа.
  // Пока интерфейс не должен отправлять вызовы несуществующих игровых API.
  const routes = [...html.matchAll(/action\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(routes, []);
  assert.match(server, /app\.post\('\/api\/auth\/telegram'/);
  assert.match(server, /app\.get\('\/api\/me'/);
});


test('restores the original full-resolution sky and mountain forest', () => {
  assert.match(html, /skyCanvas\.width=4096/);
  assert.match(html, /skyCanvas\.height=2048/);
  assert.match(html, /skyCtx\.scale\(4,4\)/);
  assert.match(html, /const mountainForestRows=\[-35\.2,-41\.0\]/);
});

test('restores the original forest tree generator and blossom geometry', () => {
  assert.match(html, /function gwAddBlossom\(x,z,h,seed=0,baseY=0,palette='pink'\)/);
  assert.match(html, /const mountainForestRows=\[-35\.2,-41\.0\]/);
  assert.match(html, /for\(let row=0;row<mountainForestRows\.length;row\+\+\)/);
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

test('removes the experimental rear pond, fountains and gazebo', () => {
  assert.doesNotMatch(html, /GREEN_WORLD_Rear_Pond|rearPondMaterial|GREEN_WORLD_Rear_Gazebo/);
});

test('keeps the startup splash visible until the world is built and exposes real startup failures', () => {
  assert.match(html, /function applyPlayer\(\)\{try\{drawPlayer\(\);window\.GREEN_WORLD_STARTUP_STAGE='player-world-built';\$\('login'\)\.style\.display='none'/);
  assert.match(html, /window\.GREEN_WORLD_REPORT_STARTUP_ERROR=function\(message\)/);
  assert.match(html, /moduleScript\.onerror=\(\)=>\{\s*window\.GREEN_WORLD_REPORT_STARTUP_ERROR/);
});
