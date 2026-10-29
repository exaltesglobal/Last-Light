// The check-in link from reminder emails. The token sits in the URL fragment,
// so it never appears in server logs, and the signal is only sent on a click,
// so email security scanners that open links can't send it by accident.
import { $, api, busy, message, show } from './ui.js';

const token = location.hash.slice(1);
if (!token) {
  show($('#send'), false);
  message($('#msg'), 'This link is incomplete. Open the link from your email again, or log in to send your signal.');
}

$('#send').addEventListener('click', (e) => {
  busy(e.currentTarget, $('#msg'), async () => {
    const res = await api('POST', '/api/signal/token', { token });
    show($('#send'), false);
    $('#lead').textContent = res.alreadyUsed
      ? `Thanks, ${res.name}. We already have a signal from you since this email was sent, so you're all set.`
      : `Thank you, ${res.name}. Your signal is received and everything is back to normal.`;
    history.replaceState(null, '', '/signal');
  }, 'Sending…');
});
