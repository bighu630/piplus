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

const ROLE_ICONS_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
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
