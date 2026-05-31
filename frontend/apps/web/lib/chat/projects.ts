import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Claude-style projects: a named workspace that groups conversations and
 * carries shared custom instructions appended to the system prompt for every
 * turn in the project.
 *
 * Same ownerKey partitioning as conversations so multi-user browsers stay
 * isolated.
 */
export interface Project {
  id: string;
  ownerKey: string;
  name: string;
  description: string;
  /** Free-form text prepended to every system prompt in this project. */
  instructions: string;
  createdAt: number;
  updatedAt: number;
}

interface ProjectsState {
  projects: Record<string, Project>;
  order: string[];
  activeId: string | null;

  newProject: (
    ownerKey: string,
    init?: { name?: string; description?: string; instructions?: string },
  ) => string;
  updateProject: (
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description' | 'instructions'>>,
  ) => void;
  deleteProject: (id: string) => void;
  selectProject: (id: string | null) => void;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `p-${Date.now()}-${counter}`;
}

export const useProjectsStore = create<ProjectsState>()(
  persist(
    (set) => ({
      projects: {},
      order: [],
      activeId: null,

      newProject: (ownerKey, init) => {
        const id = nextId();
        const now = Date.now();
        const project: Project = {
          id,
          ownerKey,
          name: init?.name?.trim() || 'Untitled project',
          description: init?.description ?? '',
          instructions: init?.instructions ?? '',
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          projects: { ...s.projects, [id]: project },
          order: [id, ...s.order.filter((x) => x !== id)],
          activeId: id,
        }));
        return id;
      },

      updateProject: (id, patch) => {
        set((s) => {
          const existing = s.projects[id];
          if (!existing) return s;
          return {
            projects: {
              ...s.projects,
              [id]: { ...existing, ...patch, updatedAt: Date.now() },
            },
          };
        });
      },

      deleteProject: (id) => {
        set((s) => {
          const { [id]: _gone, ...rest } = s.projects;
          return {
            projects: rest,
            order: s.order.filter((x) => x !== id),
            activeId: s.activeId === id ? null : s.activeId,
          };
        });
      },

      selectProject: (id) => set({ activeId: id }),
    }),
    {
      name: 'petrobrain-projects',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          const stub: Storage = {
            length: 0,
            clear() {},
            getItem() { return null; },
            key() { return null; },
            removeItem() {},
            setItem() {},
          };
          return stub;
        }
        return window.localStorage;
      }),
      partialize: (s) => ({ projects: s.projects, order: s.order, activeId: s.activeId }),
    },
  ),
);
