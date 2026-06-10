'use client';

import type { ReactNode } from 'react';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function Sheet({ open, onClose, children }: SheetProps) {
  if (!open) return null;

  return (
    <div className="sheet-root lg:hidden" role="dialog" aria-modal="true">
      <button aria-label="关闭侧边栏" className="sheet-backdrop" onClick={onClose} type="button" />
      <div className="sheet-panel">{children}</div>
    </div>
  );
}
