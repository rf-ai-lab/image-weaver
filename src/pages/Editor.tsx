import { useRef, useState } from "react";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import VersionHistory from "@/components/VersionHistory";
import DrawingOverlay from "@/components/DrawingOverlay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send, Undo2, PenTool, ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { handleReferenceImageEdit, refineImage } from "@/lib/image-generation";

export type LLMProvider = "gemini" | "openai" | "claude";

const LLM_OPTIONS: { value: LLMProvider; label: string }[] = [
  { value: "gemini", label: "Gemini" },
  { value: "openai", label: "OpenAI" },
  { value: "claude", label: "Claude" },
];

const FORCE_REPLACE_MODE = true;

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
  const [selectedSetupImageIndex, setSelectedSetupImageIndex] = useState<number | null>(null);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [selectedLLM, setSelectedLLM] = useState<LLMProvider>("gemini");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setupImages = rows.filter((r) => Boolean(r.imageData));
  const versionImage = versions[currentVersionIndex]?.imageData;
  const selectedSetupImage =
    selectedSetupImageIndex !== null ? setupImages[selectedSetupImageIndex]?.imageData ?? null : null;
  const currentImage = selectedSetupImage || versionImage;

  const latestVersion = versions.length > 0 ? versions[versions.length - 1] : null;
  const lastGeneratedImage = latestVersion?.imageData ?? null;
  const latestObjectLayers = latestVersion?.objectLayers ?? [];
  const primaryImage = rows.find((r) => r.isPrimary)?.imageData ?? null;
  const compositionBaseImage = latestVersion?.compositionBaseImage ?? primaryImage;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Selecione um arquivo de imagem.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleRefine = async () => {
    const cleanedPrompt = prompt.trim();
    if (!cleanedPrompt && !attachedImage) return;

    const imageToSend = annotatedImage || lastGeneratedImage || currentImage;
    if (!imageToSend) {
      toast.error("Nenhuma imagem para editar. Gere a composição primeiro na tela de Configuração.");
      return;
    }

    if (cleanedPrompt.toLowerCase().includes("volte para a versão anterior") || cleanedPrompt.toLowerCase().includes("desfazer")) {
      setSelectedSetupImageIndex(null);
      undoVersion();
      setPrompt("");
      toast.info("Voltou para a versão anterior.");
      return;
    }

    setIsGenerating(true);
    try {
      // --- PATH 1: Attached reference image (replace or add) ---
      if (attachedImage) {
        const instruction = cleanedPrompt || "Adicionar novo objeto de referência";

        const result = await handleReferenceImageEdit({
          compositionBaseImage: compositionBaseImage || null,
          existingLayers: latestObjectLayers,
          referenceImage: attachedImage,
          instruction,
          currentImage: imageToSend,
          llmProvider: selectedLLM,
          forceReplaceMode: FORCE_REPLACE_MODE,
        });

        console.info("[ReferenceEditDebug] Editor result", result.debug);

        addVersion(result.imageUrl, instruction, {
          objectLayers: result.layers,
          compositionBaseImage: result.compositionBaseImage,
        });

        const actionMessage =
          result.action === "replaced_layer"
            ? `Objeto "${result.targetLabel}" substituído na composição.`
            : result.action === "ai_replace"
            ? `Substituição aplicada via IA${result.targetLabel ? ` (alvo: ${result.targetLabel})` : ""}.`
            : `Objeto "${result.targetLabel || "novo"}" adicionado à composição.`;

        setSelectedSetupImageIndex(null);
        setPrompt("");
        setAnnotatedImage(null);
        setAttachedImage(null);
        toast.success(actionMessage);
        return;
      }

      // --- PATH 2: Transform command on tracked object ---
      const parsedTransform = !annotatedImage
        ? parseObjectTransformPrompt(cleanedPrompt, latestObjectLayers)
        : null;

      if (parsedTransform && compositionBaseImage && latestObjectLayers.length > 0) {
        const { layers: updatedLayers, targetLayer } = applyObjectTransformCommand(latestObjectLayers, parsedTransform);

        if (!targetLayer) {
          throw new Error("Não encontrei o objeto alvo para transformar nesta versão.");
        }

        const imageUrl = await composeImageFromLayers(compositionBaseImage, updatedLayers);

        addVersion(imageUrl, cleanedPrompt, {
          objectLayers: updatedLayers,
          compositionBaseImage,
        });

        setSelectedSetupImageIndex(null);
        setPrompt("");
        setAnnotatedImage(null);
        setAttachedImage(null);
        toast.success(`Transformação aplicada no objeto: ${targetLayer.label}.`);
        return;
      }

      // --- PATH 3: Free-form AI refinement ---
      const { imageUrl } = await refineImage(imageToSend, cleanedPrompt, undefined, selectedLLM);
      addVersion(imageUrl, cleanedPrompt, {
        objectLayers: latestObjectLayers,
        compositionBaseImage: compositionBaseImage || imageUrl,
      });
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
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Refinamento — envie instruções e/ou imagens de referência para ajustar a composição.
            </p>
            <Select value={selectedLLM} onValueChange={(v) => setSelectedLLM(v as LLMProvider)}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LLM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {attachedImage && (
            <div className="mb-2 flex items-center gap-2">
              <div className="relative">
                <img src={attachedImage} alt="Imagem anexada" className="h-16 w-16 rounded border border-border object-cover" />
                <button
                  onClick={() => setAttachedImage(null)}
                  className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <span className="text-xs text-muted-foreground">Imagem de referência anexada</span>
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
              placeholder={attachedImage ? "Ex: trocar o arco por este, usar esse portal no altar..." : annotatedImage ? "Descreva o que alterar nas áreas marcadas..." : "Ex: reduza o portal pela metade, mova para a direita, centralize..."}
              className="min-h-[44px] max-h-[120px] resize-none text-sm"
              disabled={isGenerating}
            />
            <Button onClick={handleRefine} disabled={isGenerating || (!prompt.trim() && !attachedImage)} size="icon">
              {isGenerating ? <Loader2 className="animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
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
