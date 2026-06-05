// File tree for the Code Studio workspace (Sprint 1): a real nested folder tree built from
// flat file paths, with expand/collapse, active-file highlight and a dirty dot. Staggered in
// via the Motion Kit.

import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, FileCode, FileJson, FileText, Folder, FolderOpen, File } from 'lucide-react';
import { Stagger, StaggerItem, studioTheme } from '../kit';

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  children: TreeNode[];
}

/** Build a nested tree from sorted flat paths. */
export const buildTree = (paths: string[]): TreeNode => {
  const root: TreeNode = { name: '', path: '', isFile: false, children: [] };
  for (const full of paths) {
    const parts = full.replace(/^\/+/, '').split('/').filter(Boolean);
    let node = root;
    let acc = '';
    parts.forEach((part, i) => {
      acc += '/' + part;
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isFile === isFile);
      if (!child) {
        child = { name: part, path: acc, isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  // Folders first, then files; alphabetical within each.
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
};

const fileIcon = (name: string) => {
  if (/\.json$/.test(name)) return FileJson;
  if (/\.(md|txt)$/.test(name)) return FileText;
  if (/\.(tsx?|jsx?|css|scss|html)$/.test(name)) return FileCode;
  return File;
};

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  dirtySet: Set<string>;
  onOpen: (path: string) => void;
}

const TreeRow: React.FC<RowProps> = ({ node, depth, activePath, dirtySet, onOpen }) => {
  const [open, setOpen] = useState(depth < 2); // top levels expanded by default
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.isFile) {
    const Icon = fileIcon(node.name);
    const active = activePath === node.path;
    const dirty = dirtySet.has(node.path);
    return (
      <button
        onClick={() => onOpen(node.path)}
        style={pad}
        title={node.path}
        className={`group flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs font-mono truncate ${
          active ? `bg-sky-500/15 ${studioTheme.accent}` : `${studioTheme.textDim} hover:bg-white/5`
        }`}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
        {dirty && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
      </button>
    );
  }

  const FolderIcon = open ? FolderOpen : Folder;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={pad}
        className={`flex w-full items-center gap-1 py-1 pr-2 text-left text-xs font-semibold ${studioTheme.textDim} hover:bg-white/5`}
      >
        <Chevron className="w-3.5 h-3.5 shrink-0 opacity-60" />
        <FolderIcon className="w-3.5 h-3.5 shrink-0 text-sky-400/70" />
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.map((c) => (
        <TreeRow key={c.path} node={c} depth={depth + 1} activePath={activePath} dirtySet={dirtySet} onOpen={onOpen} />
      ))}
    </div>
  );
};

export interface FileTreeProps {
  paths: string[];
  activePath: string | null;
  dirtyPaths: string[];
  onOpen: (path: string) => void;
}

export const FileTree: React.FC<FileTreeProps> = ({ paths, activePath, dirtyPaths, onOpen }) => {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const dirtySet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);

  if (paths.length === 0) {
    return <p className={`px-3 py-2 text-xs ${studioTheme.textFaint}`}>No files yet.</p>;
  }

  return (
    <Stagger className="py-1" step={0.02}>
      {tree.children.map((node) => (
        <StaggerItem key={node.path}>
          <TreeRow node={node} depth={0} activePath={activePath} dirtySet={dirtySet} onOpen={onOpen} />
        </StaggerItem>
      ))}
    </Stagger>
  );
};
