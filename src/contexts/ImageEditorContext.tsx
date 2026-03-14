import React, { createContext, useContext, useState, useCallback } from "react";

export interface ImageRow {
  id: string;
  imageData: string | null;
  instructions: string;
  isPrimary: boolean;
}

export interface ObjectBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackedObject {
  id: string;
  label: string;
  imageData: string;
  bbox: ObjectBoundingBox;
  backgroundImage: string;
  createdAtVersion: number;
  updatedAtVersion: number;
}

export interface ImageVersion {
  label: string;
  imageData: string;
  prompt?: string;
  objects: TrackedObject[];
}

export interface AddVersionOptions {
  objects?: TrackedObject[];
}

export interface Project {
  id: string;
  name: string;
  rows: ImageRow[];
  versions: ImageVersion[];
  currentVersionIndex: number;
}

interface ImageEditorContextType {
  rows: ImageRow[];
  versions: ImageVersion[];
  currentVersionIndex: number;
  isGenerating: boolean;
  activeProjectId: string | null;
  projects: Project[];
  addRow: () => void;
  removeRow: (id: string) => void;
  updateRow: (id: string, updates: Partial<Omit<ImageRow, "id">>) => void;
  setPrimary: (id: string) => void;
  addVersion: (imageData: string, prompt?: string, options?: AddVersionOptions) => void;
  deleteVersion: (index: number) => void;
  setCurrentVersion: (index: number) => void;
  undoVersion: () => void;
  setIsGenerating: (v: boolean) => void;
  createProject: (name: string) => void;
  deleteProject: (id: string) => void;
  loadProject: (id: string) => void;
}

const ImageEditorContext = createContext<ImageEditorContextType | null>(null);

const makeFirstRow = (): ImageRow => ({
  id: crypto.randomUUID(),
  imageData: null,
  instructions: "",
  isPrimary: true,
});

const cloneObjects = (objects: TrackedObject[]): TrackedObject[] =>
  objects.map((object) => ({
    ...object,
    bbox: { ...object.bbox },
  }));

export const ImageEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImageRow[]>([makeFirstRow()]);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);
  const [isGenerating, setIsGenerating] = useState(false);

  const createProject = useCallback((name: string) => {
    if (activeProjectId) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? { ...p, rows, versions, currentVersionIndex }
            : p
        )
      );
    }

    const newRow = makeFirstRow();
    const newProject: Project = {
      id: crypto.randomUUID(),
      name,
      rows: [newRow],
      versions: [],
      currentVersionIndex: -1,
    };

    setProjects((prev) => [...prev, newProject]);
    setActiveProjectId(newProject.id);
    setRows([newRow]);
    setVersions([]);
    setCurrentVersionIndex(-1);
  }, [activeProjectId, rows, versions, currentVersionIndex]);

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeProjectId === id) {
      setActiveProjectId(null);
      setRows([makeFirstRow()]);
      setVersions([]);
      setCurrentVersionIndex(-1);
    }
  }, [activeProjectId]);

  const loadProject = useCallback((id: string) => {
    if (activeProjectId) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? { ...p, rows, versions, currentVersionIndex }
            : p
        )
      );
    }

    setProjects((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) {
        setRows(target.rows);
        setVersions(target.versions);
        setCurrentVersionIndex(target.currentVersionIndex);
        setActiveProjectId(id);
      }
      return prev;
    });
  }, [activeProjectId, rows, versions, currentVersionIndex]);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { id: crypto.randomUUID(), imageData: null, instructions: "", isPrimary: false }]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (next.length > 0 && !next.some((r) => r.isPrimary)) {
        next[0].isPrimary = true;
      }
      return next;
    });
  }, []);

  const updateRow = useCallback((id: string, updates: Partial<Omit<ImageRow, "id">>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }, []);

  const setPrimary = useCallback((id: string) => {
    setRows((prev) => prev.map((r) => ({ ...r, isPrimary: r.id === id })));
  }, []);

  const addVersion = useCallback((imageData: string, prompt?: string, options?: AddVersionOptions) => {
    setVersions((prev) => {
      const inheritedObjects = options?.objects
        ? cloneObjects(options.objects)
        : cloneObjects(prev[prev.length - 1]?.objects ?? []);

      const next = [...prev, {
        label: `Versão ${prev.length + 1}`,
        imageData,
        prompt,
        objects: inheritedObjects,
      }];

      setCurrentVersionIndex(next.length - 1);
      return next;
    });
  }, []);

  const deleteVersion = useCallback((index: number) => {
    setVersions((prev) => {
      const next = prev
        .filter((_, i) => i !== index)
        .map((v, i) => ({ ...v, label: `Versão ${i + 1}` }));

      setCurrentVersionIndex((cur) => {
        if (next.length === 0) return -1;
        if (cur === index) return Math.min(index, next.length - 1);
        if (cur > index) return cur - 1;
        return cur;
      });

      return next;
    });
  }, []);

  const setCurrentVersion = useCallback((index: number) => {
    setCurrentVersionIndex(index);
  }, []);

  const undoVersion = useCallback(() => {
    setCurrentVersionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  return (
    <ImageEditorContext.Provider
      value={{
        rows,
        versions,
        currentVersionIndex,
        isGenerating,
        activeProjectId,
        projects,
        addRow,
        removeRow,
        updateRow,
        setPrimary,
        addVersion,
        deleteVersion,
        setCurrentVersion,
        undoVersion,
        setIsGenerating,
        createProject,
        deleteProject,
        loadProject,
      }}
    >
      {children}
    </ImageEditorContext.Provider>
  );
};

export const useImageEditor = () => {
  const ctx = useContext(ImageEditorContext);
  if (!ctx) throw new Error("useImageEditor must be used within ImageEditorProvider");
  return ctx;
};
