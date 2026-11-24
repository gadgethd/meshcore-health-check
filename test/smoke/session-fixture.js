const sessionsByPage = new WeakMap();

/** Keep mocked retained state identical for individual and batched session reads. */
export async function mockSessionReads(page, sessionOrGetter) {
  let sessions = sessionsByPage.get(page);
  if (!sessions) {
    sessions = new Map();
    sessionsByPage.set(page, sessions);
    await page.route('**/api/sessions*', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const url = new URL(route.request().url());
      if (url.pathname === '/api/sessions' && url.searchParams.has('ids')) {
        const ids = url.searchParams.get('ids').split(',');
        if (!ids.some(id => sessions.has(id))) return route.fallback();
        let original = [];
        let response;
        if (!ids.every(id => sessions.has(id))) {
          response = await route.fetch();
          original = (await response.json()).sessions;
        }
        const rows = ids.map(id => {
          const fixture = sessions.get(id)?.();
          return fixture ? { sessionId: id, session: fixture }
            : original.find(row => row.sessionId === id) || { sessionId: id, missing: true };
        });
        return route.fulfill({ ...(response ? { response } : {}), json: { sessions: rows } });
      }
      const id = url.pathname.slice('/api/sessions/'.length);
      const fixture = sessions.get(id)?.();
      if (fixture) return route.fulfill({ json: fixture });
      return route.fallback();
    });
  }
  const get = typeof sessionOrGetter === 'function' ? sessionOrGetter : () => sessionOrGetter;
  const session = get();
  if (!session?.id) throw new Error('session fixture requires an identity');
  sessions.set(session.id, get);
}
