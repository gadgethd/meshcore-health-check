const statusEl = document.querySelector('#landing-status');
const containerEl = document.querySelector('#turnstile-container');
const titleEl = document.querySelector('#landing-title');
const eyebrowEl = document.querySelector('#landing-eyebrow');
const copyEl = document.querySelector('#landing-copy');

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `landing-status${type ? ` ${type}` : ''}`;
}

async function fetchBootstrap() {
  const response = await fetch('/api/bootstrap', {
    credentials: 'same-origin',
  });
  return response.json();
}

async function verifyTurnstile(token) {
  setStatus('Verifying challenge…');
  const response = await fetch('/api/verify-turnstile', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'verification_failed');
  }
}

async function waitForTurnstile() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }

    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (window.turnstile) {
        window.clearInterval(interval);
        resolve();
        return;
      }
      if (attempts >= 300) {
        window.clearInterval(interval);
        reject(new Error('turnstile_load_timeout'));
      }
    }, 100);
  });
}

async function init() {
  try {
    const bootstrap = await fetchBootstrap();
    const site = bootstrap.site || {};
    document.title = `${site.title || 'Mesh Health Check'} Verification`;
    if (eyebrowEl) {
      eyebrowEl.textContent = 'Human Verification';
    }
    if (titleEl) {
      titleEl.textContent = site.title || 'Mesh Health Check';
    }
    if (copyEl) {
      copyEl.textContent =
        `Complete the Turnstile challenge to open ${site.title || 'Mesh Health Check'} and generate test codes for ${bootstrap.testChannel?.name ? `#${bootstrap.testChannel.name}` : 'the configured channel'}.`;
    }
    if (!bootstrap.turnstile?.enabled) {
      window.location.replace('/app');
      return;
    }
    if (bootstrap.turnstile.verified) {
      window.location.replace('/app');
      return;
    }

    setStatus('Loading challenge…');
    await waitForTurnstile();

    containerEl.textContent = '';
    window.turnstile.render('#turnstile-container', {
      sitekey: bootstrap.turnstile.siteKey,
      theme: 'dark',
      callback: async (token) => {
        try {
          await verifyTurnstile(token);
          setStatus('Verification successful. Redirecting…', 'success');
          window.setTimeout(() => {
            window.location.replace('/app');
          }, 400);
        } catch (error) {
          setStatus(`Verification failed: ${error.message}`, 'error');
          if (window.turnstile) {
            window.turnstile.reset();
          }
        }
      },
      'error-callback': () => {
        setStatus('Challenge failed. Please try again.', 'error');
      },
      'expired-callback': () => {
        setStatus('Challenge expired. Please complete it again.', 'error');
      },
    });

    setStatus('Waiting for verification…');
  } catch (error) {
    setStatus(`Could not start verification: ${error.message}`, 'error');
  }
}

init();
