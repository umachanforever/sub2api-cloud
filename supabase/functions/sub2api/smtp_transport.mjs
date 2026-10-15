export function smtpOptions(config, secure = config.smtp_use_tls) {
  const local = ['localhost', '127.0.0.1', '::1'].includes(config.smtp_host.toLowerCase());
  return { host: config.smtp_host, port: config.smtp_port, secure,
    requireTLS: !secure && (config.smtp_use_tls || !!config.smtp_username && !local),
    ...(config.smtp_username ? { auth: { user: config.smtp_username, pass: config.smtp_password } } : {}),
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, logger: false, debug: false };
}
export async function smtpTransport(config, message, createTransport) {
  createTransport ??= (await import('nodemailer')).default.createTransport;
  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = createTransport(smtpOptions(config, config.smtp_use_tls && attempt === 0));
    try {
      if (!message) { await transport.verify(); return; }
      const result = await transport.sendMail({ from: { name: config.smtp_from_name, address: config.smtp_from_email }, to: message.to,
        subject: message.subject, text: message.text, messageId: `<${message.id}@sub2api-cloud.local>` });
      if (!result.accepted?.includes(message.to)) throw Object.assign(Error('smtp_recipient_rejected'), { responseCode: 550 });
      return;
    } catch (error) {
      // Retry a plaintext greeting with mandatory STARTTLS, never a certificate failure.
      if (attempt === 0 && config.smtp_use_tls && (error.code === 'ERR_SSL_WRONG_VERSION_NUMBER' || error.reason === 'wrong version number')) continue;
      if (message && !(error.responseCode >= 400) && !['AUTH', 'EHLO', 'STARTTLS', 'MAIL FROM', 'RCPT TO'].includes(error.command) && !['EAUTH', 'EDNS'].includes(error.code) && error.syscall !== 'connect') throw Object.assign(Error('smtp_delivery_uncertain'), { code: 'smtp_delivery_uncertain' });
      throw error;
    } finally { transport.close(); }
  }
}
