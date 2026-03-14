import { useState, useRef } from "react";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import VersionHistory from "@/components/VersionHistory";
import DrawingOverlay from "@/components/DrawingOverlay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Undo2, PenTool, ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { refineImage } from "@/lib/image-generation";

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
    selectedModel,
  } = useImageEditor();

  const [prompt, setPrompt] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null);
  const [selectedSetupImageIndex, setSelectedSetupImageIndex] = useState<number | null>(null);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setupImages = rows.filter((r) => Boolean(r.imageData));
  const versionImage = versions[currentVersionIndex]?.imageData;
  const selectedSetupImage =
    selectedSetupImageIndex !== null ? setupImages[selectedSetupImageIndex]?.imageData ?? null : null;
  const currentImage = selectedSetupImage || versionImage;

  const lastGeneratedImage = versions.length > 0 ? versions[versions.length - 1].imageData : null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleRefine = async () => {
    if (!prompt.trim()) return;

    const imageToSend = annotatedImage || lastGeneratedImage || currentImage;
    if (!imageToSend) {
      toast.error("Nenhuma imagem para editar. Gere a composição primeiro na tela de Configuração.");
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
      const { imageUrl } = await refineImage(imageToSend, prompt.trim(), selectedModel, attachedImage || undefined);
      addVersion(imageUrl, prompt);
      setSelectedSetupImageIndex(null);
      setPrompt("");
      setAnnotatedImage(null);
      setAttachedImage(null);
      toast.success("Imagem atualizada!");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Erro ao editar imagem";
      console.error(e);
      toast.error(message);
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

  if (versions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">
          Nenhuma imagem gerada ainda. Volte para a Configuração e gere a composição.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {isAnnotating && currentImage && (
        <DrawingOverlay imageUrl={currentImage} onAnnotatedImage={handleAnnotatedImage} onCancel={() => setIsAnnotating(false)} />
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
          return caption ? <p className="mt-3 max-w-xl text-center text-sm text-muted-foreground">{caption}</p> : null;
        })()}
      </div>

      <div className="border-t border-border bg-card px-6 py-4">
        <div className="mx-auto max-w-2xl">
          <p className="mb-2 text-xs text-muted-foreground">
            Refinamento — envie texto e/ou uma nova imagem de referência para ajustar a composição.
          </p>

          {attachedImage && (
            <div className="mb-2 flex items-center gap-2">
              <img src={attachedImage} alt="Imagem anexada" className="h-12 w-12 rounded border border-border object-cover" />
              <span className="text-xs text-muted-foreground">Imagem anexada</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setAttachedImage(null)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}

          <div className="flex items-end gap-2">
            <Button variant="outline" size="icon" onClick={() => { setSelectedSetupImageIndex(null); undoVersion(); }} disabled={currentVersionIndex <= 0} title="Desfazer">
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button variant={annotatedImage ? "default" : "outline"} size="icon" onClick={() => setIsAnnotating(true)} disabled={isGenerating || !currentImage} title="Marcar na imagem">
              <PenTool className="h-4 w-4" />
            </Button>
            <Button variant={attachedImage ? "default" : "outline"} size="icon" onClick={() => fileInputRef.current?.click()} disabled={isGenerating} title="Anexar imagem de referência">
              <ImagePlus className="h-4 w-4" />
            </Button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={attachedImage ? "Descreva como usar a imagem anexada..." : annotatedImage ? "Descreva o que alterar nas áreas marcadas..." : "Ex: mude a cor das flores para rosa, remova o arranjo da esquerda..."}
              className="min-h-[44px] max-h-[120px] resize-none text-sm"
              disabled={isGenerating}
            />
            <Button onClick={handleRefine} disabled={isGenerating || !prompt.trim()} size="icon">
              {isGenerating ? <Loader2 className="animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      <VersionHistory
        setupImages={setupImages}
        selectedSetupImageIndex={selectedSetupImageIndex}
        onSelectSetupImage={(index) => { setSelectedSetupImageIndex(index); setAnnotatedImage(null); }}
        onSelectVersion={(index) => { setSelectedSetupImageIndex(null); setAnnotatedImage(null); setCurrentVersion(index); }}
      />
    </div>
  );
};

export default Editor;
