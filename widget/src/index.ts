import type { WayfinderWidgetProps } from './WayfinderWidget';
import { WayfinderWidget } from './WayfinderWidget';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';

export { WayfinderWidget };
export type { WayfinderWidgetProps };

export function renderWayfinderWidget(target: HTMLElement, props?: WayfinderWidgetProps): Root {
  const root = createRoot(target);
  root.render(
    <React.StrictMode>
      <WayfinderWidget {...props} />
    </React.StrictMode>,
  );
  return root;
}
