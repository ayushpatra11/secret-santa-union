// Transactional email via Brevo or Resend (HTTP APIs - Workers can't speak SMTP easily).
// Set EMAIL_PROVIDER to "brevo", "resend" or "console" (logs instead of sending; dev only).

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendEmail(env, { to, toName, subject, html, text }) {
  const provider = (env.EMAIL_PROVIDER || 'console').toLowerCase();
  const fromName = env.EMAIL_FROM_NAME || 'PhilipWantedAGift.com';
  const from = env.EMAIL_FROM;

  if (provider === 'console') {
    // Console mode prints email bodies (which can contain matches), so it only works locally.
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.APP_URL || '')) {
      throw new Error('EMAIL_PROVIDER=console is only allowed when APP_URL is localhost.');
    }
    // Never log addresses: only the subject and body (dev convenience for OTPs).
    console.log(`[email:console] subject="${subject}"\n${text}`);
    return;
  }
  if (!env.EMAIL_API_KEY || !from) throw new Error('Email is not configured (EMAIL_API_KEY / EMAIL_FROM).');

  let res;
  if (provider === 'brevo') {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.EMAIL_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: from },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
  } else if (provider === 'resend') {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, html, text }),
    });
  } else {
    throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Provider error bodies can echo the recipient; strip anything that looks like an email.
    throw new Error(`Email provider ${provider} returned ${res.status}: ${body.replace(/[^\s@]+@[^\s@]+/g, '[redacted]').slice(0, 300)}`);
  }
}

function layout(title, inner, appUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0b1530;font-family:Georgia,'Times New Roman',serif;color:#f6efe2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1530;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#13224a;border-radius:20px;border:1px solid #2a3c6e;overflow:hidden">
<tr><td style="background:linear-gradient(135deg,#b3243b,#7d1530);padding:28px 28px 22px;text-align:center">
<div style="font-size:34px;line-height:1">🎄</div>
<div style="font-size:13px;letter-spacing:4px;text-transform:uppercase;color:#ffd98a;margin-top:10px">PhilipWantedAGift.com</div><div style="font-family:Arial,sans-serif;font-size:12px;color:#ffd9df;margin-top:4px">a very serious Secret Santa</div>
</td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
<tr><td style="padding:0 28px 26px;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#8e9cc4">
Sent with love (and zero peeking) by <a href="${escapeHtml(appUrl)}" style="color:#ffd98a;text-decoration:none">PhilipWantedAGift.com</a>. Please don't reply to this email.
</td></tr></table></td></tr></table></body></html>`;
}

export function otpEmail(env, code) {
  const appUrl = env.APP_URL || '';
  const html = layout(
    'Your login code',
    `<p style="font-size:18px;margin:0 0 14px">Ho ho ho! Philip fetched your login code:</p>
<div style="font-family:'Courier New',monospace;font-size:38px;letter-spacing:10px;font-weight:bold;text-align:center;background:#0b1530;border:1px dashed #ffd98a;color:#ffd98a;border-radius:14px;padding:18px 8px;margin:6px 0 18px">${escapeHtml(code)}</div>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#c9d2ee;margin:0">It expires in 10 minutes. If you didn't ask for it, you can safely ignore this email - nobody can log in without the code.</p>`,
    appUrl,
  );
  const text = `Your Secret Santa login code is ${code}\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`;
  return { subject: `${code} is your PhilipWantedAGift.com code`, html, text };
}

export function assignmentEmail(env, { giverName, gifteeName, wishlist, exchange, revealUrl, isRedraw }) {
  const appUrl = env.APP_URL || '';
  const details = [];
  if (exchange.budget) details.push(['Budget', exchange.budget]);
  if (exchange.event_date) details.push(['Gift exchange', exchange.event_date]);
  const rows = details
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#8e9cc4;font-family:Arial,sans-serif;font-size:13px">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;font-family:Arial,sans-serif;font-size:14px">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const html = layout(
    'Your Secret Santa match',
    `<p style="font-size:18px;margin:0 0 6px">Dear ${escapeHtml(giverName)},</p>
${isRedraw ? `<p style="font-family:Arial,sans-serif;font-size:14px;background:#3a1430;border-radius:10px;padding:12px;margin:0 0 14px">Heads up: an email bounced, so the organiser redrew the names. <b>This match replaces any earlier one.</b></p>` : ''}
<p style="font-family:Arial,sans-serif;font-size:15px;color:#c9d2ee;margin:0 0 22px">Everyone has joined <b style="color:#f6efe2">${escapeHtml(exchange.name)}</b> and the names have been drawn. This year, you are the Secret Santa for&hellip;</p>
<div style="text-align:center;background:#0b1530;border:1px solid #ffd98a;border-radius:16px;padding:24px 12px;margin:0 0 22px">
<div style="font-size:30px;line-height:1">🎁</div>
<div style="font-size:30px;color:#ffd98a;margin-top:10px">${escapeHtml(gifteeName)}</div>
</div>
${wishlist ? `<p style="font-family:Arial,sans-serif;font-size:13px;color:#8e9cc4;margin:0 0 6px;text-transform:uppercase;letter-spacing:2px">Their wishlist &amp; hints</p><p style="font-family:Arial,sans-serif;font-size:15px;white-space:pre-wrap;background:#0b1530;border-radius:12px;padding:14px;margin:0 0 22px">${escapeHtml(wishlist)}</p>` : ''}
${rows ? `<table role="presentation" width="100%" style="border-top:1px solid #2a3c6e;margin:0 0 18px">${rows}</table>` : ''}
${exchange.message ? `<p style="font-style:italic;color:#c9d2ee;margin:0 0 18px">&ldquo;${escapeHtml(exchange.message)}&rdquo;</p>` : ''}
<div style="text-align:center;margin:0 0 20px"><a href="${escapeHtml(revealUrl)}" style="display:inline-block;background:#f2c36b;color:#3a2405;font-family:Arial,sans-serif;font-weight:bold;text-decoration:none;padding:13px 22px;border-radius:12px">Open my gift in the app 🎁</a></div>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#c9d2ee;margin:0">Keep it secret, keep it safe. 🤫 Nobody else can see who you got: not the organiser, not even whoever runs this website. Your match is locked with a key that exists only in this email, so <b>keep this email</b>.</p>`,
    appUrl,
  );
  const text = [
    `Dear ${giverName},`,
    '',
    isRedraw ? 'An email bounced, so the names were redrawn. This match replaces any earlier one.\n' : '',
    `Everyone has joined "${exchange.name}" and the names have been drawn.`,
    `You are the Secret Santa for: ${gifteeName}`,
    wishlist ? `\nTheir wishlist & hints:\n${wishlist}` : '',
    exchange.budget ? `\nBudget: ${exchange.budget}` : '',
    exchange.event_date ? `Gift exchange: ${exchange.event_date}` : '',
    exchange.message ? `\n"${exchange.message}"` : '',
    '',
    `Open it in the app: ${revealUrl}`,
    'Keep it secret! Nobody else can see who you got. Keep this email - the link above is the only key to your match.',
  ].join('\n');
  return { subject: `🎅 Your Secret Santa match for ${exchange.name}`, html, text };
}
