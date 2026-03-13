import { useState } from "react";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import VersionHistory from "@/components/VersionHistory";
import DrawingOverlay from "@/components/DrawingOverlay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Undo2, PenTool } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const Editor = () => {
  const { versions, currentVersionIndex, addVersion, undoVersion, isGenerating, setIsGenerating } = useImageEditor();
  const [prompt, setPrompt] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null);

  const currentImage = versions[currentVersionIndex]?.imageData;

  const handleRefine = async () => {
    if (!prompt.trim()) return;
    if (!currentImage) {
      toast.error("Nenhuma imagem para editar. Gere a primeira versão.");
      return;
    }

    if (prompt.toLowerCase().includes("volte para a versão anterior") || prompt.toLowerCase().includes("desfazer")) {
      undoVersion();
      setPrompt("");
      toast.info("Voltou para a versão anterior.");
      return;
    }

    setIsGenerating(true);
    try {
      // Use annotated image if available, otherwise use current version
      const imageToSend = annotatedImage || currentImage;
      
      const content = [
        { type: "text", text: `Edite esta imagem conforme solicitado. Execute TODAS as instruções a seguir: ${prompt}` },
        { type: "image_url", image_url: { url: imageToSend } },
      ];

      const { data, error } = await supabase.functions.invoke("edit-image", {
        body: { content },
      });

      if (error) throw error;
      if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada");

      addVersion(data.imageUrl);
      setPrompt("");
      setAnnotatedImage(null);
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

  if (versions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Nenhuma imagem gerada ainda. Volte para a Configuração e gere a primeira versão.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Annotation overlay */}
      {isAnnotating && currentImage && (
        <DrawingOverlay
          imageUrl={currentImage}
          onAnnotatedImage={handleAnnotatedImage}
          onCancel={() => setIsAnnotating(false)}
        />
      )}

      {/* Main image */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        <div className="relative">
          <img
            src={annotatedImage || currentImage}
            alt={`Versão ${currentVersionIndex + 1}`}
            className="max-h-[60vh] max-w-full rounded-lg border border-border object-contain shadow-sm"
          />
          {annotatedImage && (
            <div className="absolute -top-2 -right-2 rounded-full bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">
              Marcado
            </div>
          )}
        </div>
      </div>

      {/* Refinement input */}
      <div className="border-t border-border bg-card px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <Button variant="outline" size="icon" onClick={undoVersion} disabled={currentVersionIndex <= 0} title="Desfazer">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant={annotatedImage ? "default" : "outline"}
            size="icon"
            onClick={() => setIsAnnotating(true)}
            disabled={isGenerating}
            title="Marcar na imagem"
          >
            <PenTool className="h-4 w-4" />
          </Button>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={annotatedImage ? "Descreva o que alterar nas áreas marcadas..." : "Descreva as alterações desejadas..."}
            className="min-h-[44px] max-h-[120px] resize-none text-sm"
            disabled={isGenerating}
          />
          <Button onClick={handleRefine} disabled={isGenerating || !prompt.trim()} size="icon">
            {isGenerating ? <Loader2 className="animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Version history */}
      <VersionHistory />
    </div>
  );
};

export default Editor;
