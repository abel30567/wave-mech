import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 4317);
createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ application: 'wave-mech', status: 'scaffold' }));
}).listen(port, '127.0.0.1', () => {
  console.info(`wave-mech scaffold listening on http://127.0.0.1:${port}`);
});
