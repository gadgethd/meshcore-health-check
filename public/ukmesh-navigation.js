const { hostname, port, protocol } = window.location;
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const privateLan = /^(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(hostname);
const sitePort = loopback && port === '3090' ? 5173 : (privateLan || loopback) && port === '8089' ? 8083 : null;
for (const link of document.querySelectorAll('[data-ukmesh-home]')) {
  if (window.parent !== window) {
    link.remove();
  } else if (protocol === 'http:' && sitePort) {
    link.href = `http://${hostname}:${sitePort}/health-check`;
  }
}
