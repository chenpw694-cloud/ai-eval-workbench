import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-actions">{action}</div>}</div>;
}
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`pill pill-${tone}`}>{children}</span>; }
export function ProductAvatar({ letter, color, small = false }: { letter: string; color: string; small?: boolean }) { return <span className={`product-avatar avatar-${color} ${small ? 'small' : ''}`}>{letter}</span>; }
export function PanelHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>; }
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) { return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={14} /></button>; }
