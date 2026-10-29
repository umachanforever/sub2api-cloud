export function formatTime(value, timeZone, locale = 'zh-CN') {
  if (!value || !Number.isFinite(Date.parse(value))) return '未知';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone,
  }).format(new Date(value));
}
