import type { ReactNode } from 'react';

export function SidebarOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} /> : null;
}

export function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <h3 className="text-[10px] font-semibold text-zh-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
      {icon}
      {label}
    </h3>
  );
}
