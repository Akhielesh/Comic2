// Icon + status visual helpers for the Connectors UI. Connector metadata carries a
// lucide icon NAME (e.g. 'Mail'); we map it to a component here so adding a connector
// needs no UI change beyond (optionally) extending this map.

import React from 'react';
import {
  Mail,
  MapPin,
  Calendar,
  FileText,
  Table,
  Youtube,
  HardDrive,
  Plug,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  XCircle,
  CircleSlash,
  type LucideIcon
} from 'lucide-react';
import type { ConnectionStatus } from '../../services/connectorsApi';

const ICONS: Record<string, LucideIcon> = {
  Mail,
  MapPin,
  Calendar,
  FileText,
  Table,
  Youtube,
  HardDrive,
  Plug
};

export const ConnectorIcon: React.FC<{ name: string; className?: string }> = ({ name, className }) => {
  const Icon = ICONS[name] || Plug;
  return <Icon className={className} aria-hidden />;
};

export interface StatusVisual {
  label: string;
  /** Tailwind classes for the dot/badge tint. */
  tint: string;
  Icon: LucideIcon;
  /** Whether this status warrants a reconnect action. */
  needsReconnect: boolean;
}

export const statusVisual = (status: ConnectionStatus | 'available'): StatusVisual => {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tint: 'text-emerald-600 bg-emerald-500/10', Icon: CheckCircle2, needsReconnect: false };
    case 'syncing':
      return { label: 'Syncing…', tint: 'text-sky-600 bg-sky-500/10', Icon: RefreshCw, needsReconnect: false };
    case 'error':
      return { label: 'Error', tint: 'text-rose-600 bg-rose-500/10', Icon: AlertTriangle, needsReconnect: false };
    case 'expired':
      return { label: 'Needs reconnect', tint: 'text-amber-600 bg-amber-500/10', Icon: AlertTriangle, needsReconnect: true };
    case 'disconnected':
      return { label: 'Disconnected', tint: 'text-[var(--ds-muted)] bg-[var(--ds-well)]', Icon: CircleSlash, needsReconnect: false };
    default:
      return { label: 'Available', tint: 'text-[var(--ds-muted)] bg-[var(--ds-well)]', Icon: XCircle, needsReconnect: false };
  }
};
