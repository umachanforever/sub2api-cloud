import net from 'node:net';
import tls from 'node:tls';

export async function smtpCaptureServer(certificate, implicit = false) {
  const sockets = new Set(), messages = [];
  const context = certificate ? tls.createSecureContext(certificate) : undefined;
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  function attach(socket, encrypted = false, greeting = true) {
    track(socket);
    if (greeting) socket.write('220 localhost fixture\r\n');
    let buffer = '', data = false, lines = [];
    const read = chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { messages.push(lines.join('\n')); lines = []; data = false; socket.write('250 queued locally\r\n'); }
          else lines.push(line);
        } else if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write(context && !encrypted ? '250-localhost\r\n250 STARTTLS\r\n' : '250 localhost\r\n');
        else if (line === 'STARTTLS' && context && !encrypted) {
          socket.write('220 Ready for TLS\r\n'); socket.off('data', read);
          attach(new tls.TLSSocket(socket, { isServer: true, secureContext: context }), true, false); return;
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    };
    socket.on('data', read);
  }
  const server = implicit ? tls.createServer(certificate, socket => attach(socket, true)) : net.createServer(socket => attach(socket));
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, messages, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
