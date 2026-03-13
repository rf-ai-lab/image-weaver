import { useState } from "react";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import VersionHistory from "@/components/VersionHistory";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const Editor = () => {
  const { versions, currentVersionIndex, addVersion, undoVersion, isGenerating, setIsGenerating } = useImageEditor();
  const [prompt, setPrompt] = useState("");

  const currentImage = versions[currentVersionIndex]?.imageData;

  const handleRefine = async () => {
    if (!prompt.trim()) return;
    if (!currentImage) {
      toast.error("Nenhuma imagem para editar. Gere a primeira versão.");
      return;
    }

    // Check for undo command
    if (prompt.toLowerCase().includes("volte para a versão anterior") || prompt.toLowerCase().includes("desfazer")) {
      undoVersion();
      setPrompt("");
      toast.info("Voltou para a versão anterior.");
      return;
    }

    setIsGenerating(true);
    try {
      const content = [
        { type: "text", text: `Edite esta imagem conforme solicitado: ${prompt}` },
        { type: "image_url", image_url: { url: currentImage } },
      ];

      const { data, error } = await supabase.functions.invoke("edit-image", {
        body: { content },
      });

      if (error) throw error;
      if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada");

      addVersion(data.imageUrl);
      setPrompt("");
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

  if (versions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Nenhuma imagem gerada ainda. Volte para a Configuração e gere a primeira versão.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Main image */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        <img
          src={currentImage}
          alt={`Versão ${currentVersionIndex + 1}`}
          className="max-h-[60vh] max-w-full rounded-lg border border-border object-contain shadow-sm"
        />
      </div>

      {/* Refinement input */}
      <div className="border-t border-border bg-card px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <Button variant="outline" size="icon" onClick={undoVersion} disabled={currentVersionIndex <= 0} title="Desfazer">
            <Undo2 className="h-4 w-4" />
          </Button>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Descreva as alterações desejadas..."
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
