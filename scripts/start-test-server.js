import { server } from '../server.js';

const port = Number(process.env.PORT || 3091);

server.listen(port, '127.0.0.1', () => {
  console.log(`[test-web] listening on http://127.0.0.1:${port}`);
});
