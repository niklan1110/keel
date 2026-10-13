import { createContext, useContext } from 'react';
import type { Container, Drawer, Instance, Overview, Table } from './types';

export type StudioCtx = {
  instance: Instance;
  project: string;
  schema: string;
  tables: Table[];
  /** False until the schema for the current project/schema has loaded. */
  tablesLoaded: boolean;
  overview: Overview | null;
  containers: Container[];
  docker: boolean;
  mobile: boolean;
  open: (d: Drawer) => void;
  close: () => void;
  reloadSchema: () => Promise<void>;
  reloadOverview: () => Promise<void>;
  reloadStack: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  /** Fetches /api/instance again (after the public address changes). */
  reloadInstance: () => Promise<void>;
  switchProject: (name: string) => void;
};

export const Ctx = createContext<StudioCtx>(null as unknown as StudioCtx);
export const useStudio = () => useContext(Ctx);

export const projectPath = (project: string) => `/api/projects/${encodeURIComponent(project)}`;
