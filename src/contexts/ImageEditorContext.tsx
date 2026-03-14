import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

export interface ImageRow {
  id: string;
  imageData: string | null;
  instructions: string;
  isPrimary: boolean;
}

export interface ImageVersion {
  label: string;
  imageData: string;
  prompt?: string;
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
  loadingProjects: boolean;
  addRow: () => void;
  removeRow: (id: string) => void;
  updateRow: (id: string, updates: Partial<Omit<ImageRow, "id">>) => void;
  setPrimary: (id: string) => void;
  addVersion: (imageData: string, prompt?: string) => void;
  deleteVersion: (index: number) => void;
  setCurrentVersion: (index: number) => void;
  undoVersion: () => void;
  setIsGenerating: (v: boolean) => void;
  createProject: (name: string) => void;
  deleteProject: (id: string) => void;
  loadProject: (id: string) => void;
  refreshProjects: () => void;
}

const ImageEditorContext = createContext<ImageEditorContextType | null>(null);

const makeFirstRow = (): ImageRow => ({
  id: crypto.randomUUID(),
  imageData: null,
  instructions: "",
  isPrimary: true,
});

export const ImageEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImageRow[]>([makeFirstRow()]);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);
  const [isGenerating, setIsGenerating] = useState(false);

  // Auto-save debounce
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSaving = useRef(false);

  // ─── Load projects from DB ───
  const fetchProjects = useCallback(async () => {
    if (!user) return;
    setLoadingProjects(true);
    try {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      const mapped: Project[] = (data ?? []).map((row) => {
        const d = row.data as Record<string, unknown> | null;
        return {
          id: row.id,
          name: row.name,
          rows: (d?.rows as ImageRow[]) ?? [makeFirstRow()],
          versions: (d?.versions as ImageVersion[]) ?? [],
          currentVersionIndex: (d?.currentVersionIndex as number) ?? -1,
        };
      });
      setProjects(mapped);
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setLoadingProjects(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) fetchProjects();
    else {
      setProjects([]);
      setActiveProjectId(null);
      setRows([makeFirstRow()]);
      setVersions([]);
      setCurrentVersionIndex(-1);
    }
  }, [user, fetchProjects]);

  // ─── Auto-save to DB ───
  const saveToDb = useCallback(
    async (projectId: string, data: { rows: ImageRow[]; versions: ImageVersion[]; currentVersionIndex: number }) => {
      if (!user || isSaving.current) return;
      isSaving.current = true;
      try {
        const { error } = await supabase
          .from("projects")
          .update({
            data: data as unknown as Record<string, unknown>,
            updated_at: new Date().toISOString(),
          })
          .eq("id", projectId)
          .eq("user_id", user.id);
        if (error) console.error("Auto-save error:", error);
      } finally {
        isSaving.current = false;
      }
    },
    [user]
  );

  const scheduleSave = useCallback(() => {
    if (!activeProjectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const pid = activeProjectId;
    saveTimerRef.current = setTimeout(() => {
      // Grab latest state via setter callbacks
      setRows((r) => {
        setVersions((v) => {
          setCurrentVersionIndex((ci) => {
            saveToDb(pid, { rows: r, versions: v, currentVersionIndex: ci });
            return ci;
          });
          return v;
        });
        return r;
      });
    }, 2000);
  }, [activeProjectId, saveToDb]);

  // Trigger auto-save on state changes
  useEffect(() => {
    if (activeProjectId) scheduleSave();
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [rows, versions, currentVersionIndex, activeProjectId, scheduleSave]);

  // ─── CRUD ───
  const createProject = useCallback(
    async (name: string) => {
      if (!user) return;
      const newRow = makeFirstRow();
      const projectData = { rows: [newRow], versions: [], currentVersionIndex: -1 };

      try {
        const { data, error } = await supabase
          .from("projects")
          .insert({
            user_id: user.id,
            name,
            data: projectData as unknown as Record<string, unknown>,
          })
          .select()
          .single();

        if (error) throw error;

        const newProject: Project = {
          id: data.id,
          name: data.name,
          rows: [newRow],
          versions: [],
          currentVersionIndex: -1,
        };

        setProjects((prev) => [newProject, ...prev]);
        setActiveProjectId(newProject.id);
        setRows([newRow]);
        setVersions([]);
        setCurrentVersionIndex(-1);
      } catch (err) {
        console.error("Error creating project:", err);
        toast.error("Erro ao criar projeto.");
      }
    },
    [user]
  );

  const deleteProject = useCallback(
    async (id: string) => {
      if (!user) return;
      try {
        const { error } = await supabase
          .from("projects")
          .delete()
          .eq("id", id)
          .eq("user_id", user.id);
        if (error) throw error;

        setProjects((prev) => prev.filter((p) => p.id !== id));
        if (activeProjectId === id) {
          setActiveProjectId(null);
          setRows([makeFirstRow()]);
          setVersions([]);
          setCurrentVersionIndex(-1);
        }
      } catch (err) {
        console.error("Error deleting project:", err);
        toast.error("Erro ao excluir projeto.");
      }
    },
    [user, activeProjectId]
  );

  const loadProject = useCallback(
    (id: string) => {
      // Save current first (immediate)
      if (activeProjectId && user) {
        saveToDb(activeProjectId, { rows, versions, currentVersionIndex });
      }

      const target = projects.find((p) => p.id === id);
      if (target) {
        setRows(target.rows);
        setVersions(target.versions);
        setCurrentVersionIndex(target.currentVersionIndex);
        setActiveProjectId(id);
      }
    },
    [activeProjectId, user, rows, versions, currentVersionIndex, projects, saveToDb]
  );

  const refreshProjects = useCallback(() => {
    fetchProjects();
  }, [fetchProjects]);

  // ─── Row operations ───
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

  // ─── Version operations ───
  const addVersion = useCallback((imageData: string, prompt?: string) => {
    setVersions((prev) => {
      const next = [...prev, { label: `Versão ${prev.length + 1}`, imageData, prompt }];
      setCurrentVersionIndex(next.length - 1);
      return next;
    });
  }, []);

  const deleteVersion = useCallback((index: number) => {
    setVersions((prev) => {
      const next = prev.filter((_, i) => i !== index).map((v, i) => ({ ...v, label: `Versão ${i + 1}` }));
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
        loadingProjects,
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
        refreshProjects,
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
