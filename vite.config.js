import { defineConfig } from 'vite';

// The Maps key only allows localhost:5173, so both modes use that port and never switch.
const devAndPreview = {
  port: 5173,
  strictPort: true,
  // Send /api requests from the website to our Express server.
  proxy: { '/api': 'http://localhost:3001', '^/admin$': 'http://localhost:3001' },
};

export default defineConfig({
  server: devAndPreview, // npm run dev
  preview: devAndPreview, // npm run preview (tests the built app, including the service worker)
});
