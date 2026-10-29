import { formatTime } from './time.js';

const $ = id => document.getElementById(id);
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let token = '', snapshot, busy = false;
const zone = () => $('zone').value === 'UTC' ? 'UTC' : localZone;
const labels = { five_hour: '5 小时额度', seven_day: '7 天额度' };
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render() {
  $('timezone').textContent = `时区：${zone()} · 自动按设备所在地显示`;
  $('accounts').replaceChildren();
  if (!snapshot) return;
  for (const account of snapshot.accounts) {
    const card = element('section', undefined, 'card');
    card.append(element('h2', account.account_name));
    if (account.stale) card.append(element('p', '暂时无法获取最新用量，以下为缓存数据。', 'warning'));
    if (!account.supported) card.append(element('p', '此账号暂不支持额度查询。'));
    for (const window of account.windows || []) {
      const row = element('div', undefined, 'window');
      row.append(element('h3', window.model || labels[window.id] || window.id));
      row.append(element('p', `已使用 ${window.used_percent ?? '未知'}%`));
      const progress = element('progress');
      progress.max = 100;
      if (typeof window.used_percent === 'number') progress.value = Math.max(0, Math.min(100, window.used_percent));
      progress.setAttribute('aria-label', '已使用额度');
      row.append(progress);
      const line = element('p', '重置时间：', 'muted');
      const time = element('time', formatTime(window.reset_at, zone()));
      if (window.reset_at) { time.dateTime = window.reset_at; time.title = window.reset_at; }
      line.append(time); row.append(line); card.append(row);
    }
    card.append(element('p', `更新时间：${formatTime(account.fetched_at, zone())}`, 'muted'));
    $('accounts').append(card);
  }
  if (!snapshot.accounts.length) $('accounts').append(element('p', '暂无可查询的账号。'));
}
async function load(refresh = false) {
  if (busy || !token) return;
  busy = true; $('refresh').disabled = true;
  $('credentials').querySelector('button').disabled = true;
  $('status').textContent = '正在获取用量…';
  try {
    const response = await fetch(`/api/usage${refresh ? '?refresh=true' : ''}`, {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Error(`查询失败（${response.status}），请检查密钥权限或稍后重试。`);
    const data = await response.json();
    if (data.object !== 'subscription.usage' || !Array.isArray(data.accounts)) throw Error('用量服务返回格式异常。');
    snapshot = data; render(); $('refresh').hidden = false;
    $('status').textContent = '已更新；时间按下方标注的时区显示。';
  } catch (error) {
    $('status').textContent = error.name === 'TimeoutError' ? '查询超时，请稍后刷新。' : error.message;
  } finally { busy = false; $('refresh').disabled = false; $('credentials').querySelector('button').disabled = false; }
}
$('credentials').addEventListener('submit', event => {
  event.preventDefault();
  const next = $('key').value.trim();
  if (token !== next) { snapshot = undefined; render(); }
  token = next; $('key').value = ''; load();
});
$('refresh').addEventListener('click', () => load(true));
$('zone').addEventListener('change', render);
// Fragments stay in the browser and are never sent to the hosting server.
const fragment = new URLSearchParams(location.hash.slice(1));
token = fragment.get('key') || '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
render();
if (token) load();
