import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, Inbox, LoaderCircle, X } from 'lucide-react';
import { errorMessage } from '../api';
import type { Status } from '../types';

export const statusLabels: Record<Status, string> = { open: '待接单', accepted: '已接单', active: '处理中', review: '待验收', done: '已完成', cancelled: '已取消' };
export const priorityLabels = { normal: '普通', high: '较高', urgent: '紧急' };
export function StatusBadge({ status }: { status: Status }) { return <span className={`status status-${status}`}><span />{statusLabels[status] || status}</span>; }
export function Avatar({ name, small = false }: { name: string; small?: boolean }) { return <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">{name.slice(0, 1)}</span>; }
export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{errorMessage(error)}</span>{onRetry && <button className="text-button" onClick={onRetry}>重试</button>}</div>;
}
export function Loading({ label = '正在加载…' }: { label?: string }) { return <div className="loading-state" role="status"><LoaderCircle size={21} className="spin" /><span>{label}</span></div>; }
export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Inbox size={26} strokeWidth={1.5} /></span><h3>{title}</h3>{text && <p>{text}</p>}{action}</div>; }
export function Dialog({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || []);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭对话框"><X size={20} /></button></header>{children}</div></div>;
}
export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) { return <label className="field"><span className="field-label">{label}{required && <span className="required"> *</span>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>; }
export function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <header className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>; }
export function ExternalLabel({ children }: { children: ReactNode }) { return <span className="external-label">{children}<ArrowUpRight size={14} /></span>; }
export function date(value: string | null | undefined, time = false) {
  if (!value) return '未约定';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric' }) }).format(parsed);
}
