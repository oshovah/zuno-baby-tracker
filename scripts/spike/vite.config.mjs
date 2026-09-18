// Serves scripts/spike/index.html over HTTPS on the LAN so a phone can run the
// crypto/IndexedDB go/no-go check (crypto.subtle needs a secure context):
//   npm run spike   →  https://<this machine's LAN IP>:5174/
// Accept the self-signed certificate on the phone once.
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [basicSsl()],
  server: { host: true, port: 5174, strictPort: true, https: true },
});
