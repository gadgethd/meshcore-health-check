/** Instructions depend on the saved session, never the map's visible marker count. */
export function checkGuidance({ session, channel, shared, missing, connected }) {
  if (shared) return {
    step: 'results',
    text: missing ? 'This saved result has expired or is unavailable.'
      : 'This is a saved result. Start your own check to test your radio.',
  };
  if (!session) return { step: 'copy', text: 'Create a code to start your check.' };
  if (session.status === 'expired') return {
    step: 'results', text: 'This code has expired. Generate a new code to test again.',
  };
  if (session.observedCount > 0) return {
    step: 'results',
    text: `${session.observedCount} of ${session.expectedCount} selected observers reported this message. Open a receipt to see its path.`,
  };
  return {
    step: 'send',
    text: connected
      ? `Paste ${session.code} into ${channel} in your MeshCore app, then send it over your radio.`
      : `The observer connection is offline. Keep this code and wait for the connection before sending to ${channel}.`,
  };
}

export function renderCheckGuidance(root, input) {
  const guidance = checkGuidance(input);
  const status = root.querySelector('#check-guidance');
  if (status) status.textContent = guidance.text;
  for (const item of root.querySelectorAll('[data-check-step]')) {
    if (item.dataset.checkStep === guidance.step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}
