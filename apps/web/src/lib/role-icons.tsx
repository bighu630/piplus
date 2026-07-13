import React from 'react';
import {
  Star, Circle, Eye, Triangle, Bug, User, FileText,
  Zap, Shield, Code, Terminal, Cpu, Database, Globe,
  Lock, Bell, Flag, Heart, Crown, Rocket, Compass,
  Target, Lightbulb, Search, Book, Pen, Palette,
  Monitor, Link, Sparkles, Bot, Brain, Activity,
  Command, Feather, Gift, HelpCircle, Navigation,
  Pin, Power, Scroll, Server, Share, Swords,
  TestTube, Timer, Trophy, Wand, Wrench,
} from 'lucide-react';

/**
 * All available role icon names. Stored as strings in configJson.
 */
export const ROLE_ICON_NAMES = [
  'Star', 'Circle', 'Eye', 'Triangle', 'Bug', 'User', 'FileText',
  'Zap', 'Shield', 'Code', 'Terminal', 'Cpu', 'Database', 'Globe',
  'Lock', 'Bell', 'Flag', 'Heart', 'Crown', 'Rocket', 'Compass',
  'Target', 'Lightbulb', 'Search', 'Book', 'Pen', 'Palette',
  'Monitor', 'Link', 'Sparkles', 'Bot', 'Brain', 'Activity',
  'Command', 'Feather', 'Gift', 'HelpCircle', 'Navigation',
  'Pin', 'Power', 'Scroll', 'Server', 'Share', 'Swords',
  'TestTube', 'Timer', 'Trophy', 'Wand', 'Wrench',
] as const;

export type RoleIconName = (typeof ROLE_ICON_NAMES)[number];

export const ROLE_ICONS_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Star, Circle, Eye, Triangle, Bug, User, FileText,
  Zap, Shield, Code, Terminal, Cpu, Database, Globe,
  Lock, Bell, Flag, Heart, Crown, Rocket, Compass,
  Target, Lightbulb, Search, Book, Pen, Palette,
  Monitor, Link, Sparkles, Bot, Brain, Activity,
  Command, Feather, Gift, HelpCircle, Navigation,
  Pin, Power, Scroll, Server, Share, Swords,
  TestTube, Timer, Trophy, Wand, Wrench,
};

export function renderRoleIcon(iconName: string | null | undefined, className?: string): React.ReactNode {
  const Icon = ROLE_ICONS_MAP[iconName ?? ''];
  if (!Icon) {
    return <FileText className={className ?? 'w-4 h-4'} />;
  }
  return <Icon className={className ?? 'w-4 h-4'} />;
}

/**
 * Returns the default icon used for display when no icon is configured.
 */
export function defaultRoleIcon(): string {
  return 'FileText';
}

/**
 * Map role keys to their default icon names (for Sidebar fallback).
 */
const ROLE_KEY_ICONS: Record<string, string> = {
  planner: 'Star',
  worker: 'Circle',
  reviewer: 'Eye',
  feature_lead: 'Triangle',
  bugfix_lead: 'Bug',
  blank: 'User',
};

/**
 * Get the icon component for a role, given optional templates data.
 * If templates data is available, looks up the icon from the backend.
 * Otherwise falls back to the hardcoded key-based map.
 */
export function getRoleIconComponent(
  roleKey: string,
  templates?: Array<{ key: string; icon: string | null }>,
): React.ComponentType<{ className?: string }> {
  if (templates) {
    const tpl = templates.find(t => t.key === roleKey);
    if (tpl?.icon && ROLE_ICONS_MAP[tpl.icon]) {
      return ROLE_ICONS_MAP[tpl.icon];
    }
  }
  const fallbackName = ROLE_KEY_ICONS[roleKey] ?? 'FileText';
  return ROLE_ICONS_MAP[fallbackName] ?? FileText;
}
