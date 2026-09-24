// 定时：每天或每周某天的 HH:MM（本机时区）。只看「最近一个应跑的时刻」有没有跑过：
// 电脑关着错过了，开机后补跑一次；错过好几次也只补一次。
export function lastSlot(now, sch) {
  const [hh, mm] = String(sch.time).split(':').map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (sch.frequency === 'weekly') {
    d.setDate(d.getDate() - ((d.getDay() - sch.weekday + 7) % 7));
    if (d > now) d.setDate(d.getDate() - 7);
  } else if (d > now) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

export function nextSlot(now, sch) {
  const d = lastSlot(now, sch);
  d.setDate(d.getDate() + (sch.frequency === 'weekly' ? 7 : 1));
  return d;
}

// 该跑就返回那个时刻，否则 null。handledIso 是上次处理过的时刻（开启或改动定时的时候也会记一次，免得一打开就跑）
export function dueSlot(now, sch, handledIso) {
  if (!sch?.enabled) return null;
  const slot = lastSlot(now, sch);
  if (handledIso && Date.parse(handledIso) >= slot.getTime()) return null;
  return slot;
}
