import React, { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  maxWidthClassName?: string; // e.g. "max-w-md"
}

export default function Modal({
  isOpen,
  onClose,
  title,
  icon,
  children,
  maxWidthClassName = "max-w-md"
}: ModalProps) {
  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-100 p-4 transition-all duration-200"
      onClick={onClose}
    >
      <div 
        className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full ${maxWidthClassName} p-6 shadow-xl space-y-4 flex flex-col h-[58vh] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3 shrink-0">
          <span className="font-bold text-slate-800 dark:text-slate-100 text-sm tracking-tight flex items-center space-x-2 select-none">
            {icon && <div className="text-slate-500 dark:text-slate-400 shrink-0">{icon}</div>}
            <span>{title}</span>
          </span>
          <button 
            type="button"
            onClick={onClose} 
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body content */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}
