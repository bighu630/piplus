/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface FileItem {
  id: string;
  name: string;
  size: string;
  type: string;
}

export interface Session {
  id: string;
  name: string;
  roleKey?: string;
  responsible: string;
  model: string;
  status: "Active" | "Archived" | "Draft";
  messages: Message[];
  files: FileItem[];
  description: string;
  tags: string[];
  gitDiffText?: string;
  isActive?: boolean;
  subSessions?: Session[];
}

export interface Project {
  id: string;
  name: string;
  collapsed: boolean;
  sessions: Session[];
  directory?: string;
  githubUrl?: string;
}
