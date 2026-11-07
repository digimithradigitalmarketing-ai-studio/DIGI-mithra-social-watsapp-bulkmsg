import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const formatPaise = (paise: number) => inr.format(Math.round(paise / 100));
export const formatNumber = (n: number) => new Intl.NumberFormat('en-IN').format(n);
export const formatDate = (iso: string | null | undefined, tz = 'Asia/Kolkata') =>
  iso ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: tz }).format(new Date(iso)) : '—';
export const formatDateTime = (iso: string | null | undefined, tz = 'Asia/Kolkata') =>
  iso ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso)) : '—';
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
export const daysUntil = (iso: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null);
