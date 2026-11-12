import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Batch M0: @xiaowu/client-core is linked from ../shared/client-core (outside this folder),
  // so the dev server must be allowed to serve it. Production builds are not affected.
  server: { fs: { allow: ['..'] } },
})
