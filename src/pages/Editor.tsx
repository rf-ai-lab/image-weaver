import { useState, useRef, useCallback } from "react";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import VersionHistory from "@/components/VersionHistory";
import DrawingOverlay from "@/components/DrawingOverlay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Undo2, PenTool, ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

const Editor = () => {
  const {
    rows,
    versions,
    currentVersionIndex,
    addVersion,
    undoVersion,
    setCurrentVersion,
    isGenerating,
    setIsGenerating,
  } = useImageEditor();

  const [prompt, setPrompt] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null);
  const [attachedImages, setAttachedImages] = useState<{ name: string; data: string }[]>([]);
  const [selectedSetupImageIndex, setSelectedSetupImageIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const setupImages = rows.filter((r) => Boolean(r.imageData));
  const versionImage = versions[currentVersionIndex]?.imageData;
  const selectedSetupImage =
    selectedSetupImageIndex !== null ? setupImages[selectedSetupImageIndex]?.imageData ?? null : null;
  const currentImage = selectedSetupImage || versionImage;

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      toast.error("Apenas arquivos de imagem são aceitos.");
      return;
    }
    const newImages = await Promise.all(
      imageFiles.map(async (f) => ({ name: f.name, data: await fileToBase64(f) }))
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeAttached = (index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRefine = async () => {
    if (!prompt.trim()) return;
    if (!currentImage) {
      toast.error("Nenhuma imagem para editar. Gere a primeira versão.");
      return;
    }

    const primaryImage = rows.find((r) => r.isPrimary)?.imageData;
    if (!primaryImage) {
      toast.error("Defina uma Foto Principal no setup para manter a estrutura.");
      return;
    }

    if (prompt.toLowerCase().includes("volte para a versão anterior") || prompt.toLowerCase().includes("desfazer")) {
      setSelectedSetupImageIndex(null);
      undoVersion();
      setPrompt("");
      toast.info("Voltou para a versão anterior.");
      return;
    }

    setIsGenerating(true);
    try {
      const imageToSend = annotatedImage || currentImage;

      const { data, error } = await supabase.functions.invoke("generate-decoration", {
        body: { image: imageToSend, prompt: prompt.trim() },
      });

      if (error) throw error;
      if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada");

      addVersion(data.imageUrl, prompt);
      setSelectedSetupImageIndex(null);
      setPrompt("");
      setAnnotatedImage(null);
      setAttachedImages([]);
      toast.success("Imagem atualizada!");
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Erro ao editar imagem");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleRefine();
    }
  };

  const handleAnnotatedImage = (dataUrl: string) => {
    setAnnotatedImage(dataUrl);
    setIsAnnotating(false);
    toast.info("Marcações aplicadas! Agora descreva o que deseja alterar nas áreas marcadas.");
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      addFiles(imageFiles);
    }
  };

  if (versions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">
          Nenhuma imagem gerada ainda. Volte para a Configuração e gere a primeira versão.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={dropZoneRef}
      className="flex flex-1 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary bg-card px-8 py-6 text-lg font-medium text-primary shadow-lg">
            Solte a imagem aqui
          </div>
        </div>
      )}

      {isAnnotating && currentImage && (
        <DrawingOverlay
          imageUrl={currentImage}
          onAnnotatedImage={handleAnnotatedImage}
          onCancel={() => setIsAnnotating(false)}
        />
      )}

      <div className="flex flex-1 flex-col items-center justify-center overflow-auto p-6">
        <div className="relative">
          <img
            src={annotatedImage || currentImage}
            alt="Imagem atual"
            className="max-h-[55vh] max-w-full rounded-lg border border-border object-contain shadow-sm"
          />
          {annotatedImage && (
            <div className="absolute -top-2 -right-2 rounded-full bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">
              Marcado
            </div>
          )}
        </div>
        {(() => {
          let caption = "";
          if (selectedSetupImageIndex !== null && setupImages[selectedSetupImageIndex]) {
            const row = setupImages[selectedSetupImageIndex];
            caption = row.instructions || (row.isPrimary ? "Foto Principal" : `Imagem de referência ${selectedSetupImageIndex + 1}`);
          } else if (currentVersionIndex >= 0 && versions[currentVersionIndex]) {
            const v = versions[currentVersionIndex];
            caption = v.prompt || v.label;
          }
          return caption ? (
            <p className="mt-3 max-w-xl text-center text-sm text-muted-foreground">{caption}</p>
          ) : null;
        })()}
      </div>

      {attachedImages.length > 0 && (
        <div className="border-t border-border bg-muted/50 px-6 py-2">
          <div className="mx-auto flex max-w-2xl gap-2 overflow-x-auto">
            {attachedImages.map((img, i) => (
              <div key={i} className="group relative flex-shrink-0">
                <img src={img.data} alt={img.name} className="h-12 w-12 rounded border border-border object-cover" />
                <button
                  onClick={() => removeAttached(i)}
                  className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
                <span className="absolute -bottom-4 left-0 max-w-[48px] truncate text-[9px] text-muted-foreground">
                  {img.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border bg-card px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              setSelectedSetupImageIndex(null);
              undoVersion();
            }}
            disabled={currentVersionIndex <= 0}
            title="Desfazer"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant={annotatedImage ? "default" : "outline"}
            size="icon"
            onClick={() => setIsAnnotating(true)}
            disabled={isGenerating || !currentImage}
            title="Marcar na imagem"
          >
            <PenTool className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating}
            title="Anexar imagem de referência"
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              annotatedImage
                ? "Descreva o que alterar nas áreas marcadas..."
                : attachedImages.length > 0
                  ? "Descreva o que fazer com as imagens anexadas..."
                  : "Descreva as alterações desejadas..."
            }
            className="min-h-[44px] max-h-[120px] resize-none text-sm"
            disabled={isGenerating}
          />
          <Button onClick={handleRefine} disabled={isGenerating || !prompt.trim()} size="icon">
            {isGenerating ? <Loader2 className="animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <VersionHistory
        setupImages={setupImages}
        selectedSetupImageIndex={selectedSetupImageIndex}
        onSelectSetupImage={(index) => {
          setSelectedSetupImageIndex(index);
          setAnnotatedImage(null);
        }}
        onSelectVersion={(index) => {
          setSelectedSetupImageIndex(null);
          setAnnotatedImage(null);
          setCurrentVersion(index);
        }}
      />
    </div>
  );
};

export default Editor;
