import React, { createContext, useContext, useState, useCallback } from "react";

export interface ImageRow {
  id: string;
  imageData: string | null; // base64
  instructions: string;
  isPrimary: boolean;
}

export interface ImageVersion {
  label: string;
  imageData: string; // base64
}

interface ImageEditorState {
  rows: ImageRow[];
  versions: ImageVersion[];
  currentVersionIndex: number;
  isGenerating: boolean;
}

interface ImageEditorContextType extends ImageEditorState {
  addRow: () => void;
  removeRow: (id: string) => void;
  updateRow: (id: string, updates: Partial<Omit<ImageRow, "id">>) => void;
  setPrimary: (id: string) => void;
  addVersion: (imageData: string) => void;
  setCurrentVersion: (index: number) => void;
  undoVersion: () => void;
  setIsGenerating: (v: boolean) => void;
}

const ImageEditorContext = createContext<ImageEditorContextType | null>(null);

let rowCounter = 1;
const makeRow = (): ImageRow => ({
  id: crypto.randomUUID(),
  imageData: null,
  instructions: "",
  isPrimary: rowCounter++ === 1,
});

export const ImageEditorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [rows, setRows] = useState<ImageRow[]>([makeRow()]);
  const [versions, setVersions] = useState<ImageVersion[]>([]);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);
  const [isGenerating, setIsGenerating] = useState(false);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { ...makeRow(), isPrimary: false }]);
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

  const addVersion = useCallback((imageData: string) => {
    setVersions((prev) => {
      const next = [...prev, { label: `Versão ${prev.length + 1}`, imageData }];
      return next;
    });
    setCurrentVersionIndex((prev) => prev + 1);
    // Fix: we need versions length at time of call
    setVersions((prev) => {
      setCurrentVersionIndex(prev.length - 1);
      return prev;
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
        addRow,
        removeRow,
        updateRow,
        setPrimary,
        addVersion,
        setCurrentVersion,
        undoVersion,
        setIsGenerating,
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
