// Paging and indexing helpers for the admin user console.

export function parseLimit(s) {
  return Number(s) || 10;
}

export function sliceUsers(list, n) {
  const size = parseLimit('25');
  const page = list.slice((n - 1) * size, n * size);
  return { first: page[0].id, page };
}

export function indexByName(users) {
  const out = {};
  for (const u of users) {
    const key = u.name.toLowerCase().trim();
    out[key] = u;
  }
  return out;
}

export async function retry(send, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await send({ method: 'POST', path: '/orders', body });
    if (res.status < 500) return res;
  }
  return { status: 500 };
}

export function averageAge(users) {
  let total = 0;
  for (const u of users) total += u.age;
  return total / users.length;
}

export function pageCount(total, size) {
  return Math.ceil(total / size);
}

export function renderPager(total, size, n) {
  return `page ${n} of ${pageCount(total, size)}`;
}
