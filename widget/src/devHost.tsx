import React from 'react';
import { createRoot } from 'react-dom/client';
import { WayfinderWidget } from './WayfinderWidget';

const mount = document.getElementById('root');

if (mount) {
  const root = createRoot(mount);
  root.render(
    <React.StrictMode>
      <WayfinderWidget />
    </React.StrictMode>,
  );
} else {
  console.error('Wayfinder widget dev host missing #root element.');
}
