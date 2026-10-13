import { createClipdockServer } from './lib/server.mjs';
import { runtimeConfig } from './lib/config.mjs';

const config = runtimeConfig();
const { port, host, publicOrigin } = config;
const server = createClipdockServer(config);
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT。` : `服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`\n  拾帧 ClipDock\n  ${publicOrigin || `http://127.0.0.1:${port}`}\n\n  按 Ctrl+C 停止服务。\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close();
  server.closeAllConnections();
});
