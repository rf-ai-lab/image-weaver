import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

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

export type LLMModel = "openai" | "gemini" | "claude";

export const LLM_OPTIONS: { value: LLMModel; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude" },
];

interface ImageEditorContextType {
  rows: ImageRow[];
  versions: ImageVersion[];
  currentVersionIndex: number;
  isGenerating: boolean;
  activeProjectId: string | null;
  projects: Project[];
  selectedModel: LLMModel;
  loadingProjects: boolean;
  setSelectedModel: (model: LLMModel) => void;
  addRow: () => void;
  removeRow: (id: string) => void;
  updateRow: (id: string, updates: Partial<Omit<ImageRow, "id">>) => void;
  setPrimary: (id: string) => void;
  addVersion: (imageData: string, prompt?: string) => void;
  deleteVersion: (index: number) => void;
  setCurrentVersion: (index: number) => void;
  undoVersion: () => void;
  setIsGenerating: (v: boolean) => void;
  createProject: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  loadProject: (id: string) => void;
  saveProject: () => Promise<void>;
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
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImageRow[]>([makeFirstRow()]);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedModel, setSelectedModel] = useState<LLMModel>("google/gemini-3.1-flash-image-preview");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load projects from DB when user logs in
  useEffect(() => {
    if (!user) {
      setProjects([]);
      setActiveProjectId(null);
      setRows([makeFirstRow()]);
      setVersions([]);
      setCurrentVersionIndex(-1);
      return;
    }

    const loadProjects = async () => {
      setLoadingProjects(true);
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, data, updated_at")
        .order("updated_at", { ascending: false });

      if (!error && data) {
        const loaded: Project[] = data.map((row: any) => ({
          id: row.id,
          name: row.name,
          rows: row.data?.rows ?? [makeFirstRow()],
          versions: row.data?.versions ?? [],
          currentVersionIndex: row.data?.currentVersionIndex ?? -1,
        }));
        setProjects(loaded);
      }
      setLoadingProjects(false);
    };

    loadProjects();
  }, [user]);

  // Auto-save active project with debounce
  const persistToDb = useCallback(async (projectId: string, projectData: { rows: ImageRow[]; versions: ImageVersion[]; currentVersionIndex: number }) => {
    if (!user) return;
    await supabase
      .from("projects")
      .update({
        data: projectData as any,
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId);
  }, [user]);

  // Debounced auto-save when active project data changes
  useEffect(() => {
    if (!activeProjectId || !user) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      persistToDb(activeProjectId, { rows, versions, currentVersionIndex });
      // Also update local projects array
      setProjects(prev => prev.map(p =>
        p.id === activeProjectId ? { ...p, rows, versions, currentVersionIndex } : p
      ));
    }, 2000);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [activeProjectId, rows, versions, currentVersionIndex, persistToDb, user]);

  const saveProject = useCallback(async () => {
    if (!activeProjectId || !user) return;
    await persistToDb(activeProjectId, { rows, versions, currentVersionIndex });
  }, [activeProjectId, user, rows, versions, currentVersionIndex, persistToDb]);

  const createProject = useCallback(async (name: string) => {
    if (!user) return;
    const newRow = makeFirstRow();
    const projectData = { rows: [newRow], versions: [], currentVersionIndex: -1 };

    const { data, error } = await supabase
      .from("projects")
      .insert({
        user_id: user.id,
        name,
        data: projectData as any,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Error creating project:", error);
      return;
    }

    const newProject: Project = {
      id: data.id,
      name,
      rows: [newRow],
      versions: [],
      currentVersionIndex: -1,
    };

    setProjects(prev => [newProject, ...prev]);
    setActiveProjectId(data.id);
    setRows([newRow]);
    setVersions([]);
    setCurrentVersionIndex(-1);
  }, [user]);

  const deleteProject = useCallback(async (id: string) => {
    if (!user) return;
    await supabase.from("projects").delete().eq("id", id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProjectId === id) {
      setActiveProjectId(null);
      setRows([makeFirstRow()]);
      setVersions([]);
      setCurrentVersionIndex(-1);
    }
  }, [user, activeProjectId]);

  const loadProject = useCallback((id: string) => {
    const target = projects.find(p => p.id === id);
    if (target) {
      setActiveProjectId(id);
      setRows(target.rows);
      setVersions(target.versions);
      setCurrentVersionIndex(target.currentVersionIndex);
    }
  }, [projects]);

  const addRow = useCallback(() => {
    setRows(prev => [...prev, { id: crypto.randomUUID(), imageData: null, instructions: "", isPrimary: false }]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows(prev => {
      const next = prev.filter(r => r.id !== id);
      if (next.length > 0 && !next.some(r => r.isPrimary)) next[0].isPrimary = true;
      return next;
    });
  }, []);

  const updateRow = useCallback((id: string, updates: Partial<Omit<ImageRow, "id">>) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...updates } : r)));
  }, []);

  const setPrimary = useCallback((id: string) => {
    setRows(prev => prev.map(r => ({ ...r, isPrimary: r.id === id })));
  }, []);

  const addVersion = useCallback((imageData: string, prompt?: string) => {
    setVersions(prev => {
      const next = [...prev, { label: `Versão ${prev.length + 1}`, imageData, prompt }];
      setCurrentVersionIndex(next.length - 1);
      return next;
    });
  }, []);

  const deleteVersion = useCallback((index: number) => {
    setVersions(prev => {
      const next = prev.filter((_, i) => i !== index).map((v, i) => ({ ...v, label: `Versão ${i + 1}` }));
      setCurrentVersionIndex(cur => {
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
    setCurrentVersionIndex(prev => Math.max(0, prev - 1));
  }, []);

  return (
    <ImageEditorContext.Provider
      value={{
        rows, versions, currentVersionIndex, isGenerating, activeProjectId, projects,
        selectedModel, loadingProjects, setSelectedModel,
        addRow, removeRow, updateRow, setPrimary,
        addVersion, deleteVersion, setCurrentVersion, undoVersion,
        setIsGenerating, createProject, deleteProject, loadProject, saveProject,
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
