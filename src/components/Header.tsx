import { useState } from "react";
import { NavLink } from "@/components/NavLink";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import { generateImageWithFallback } from "@/lib/image-generation";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

type LlmProvider = "openai" | "claude" | "gemini";

const Header = () => {
  const { rows, isGenerating, setIsGenerating, addVersion } = useImageEditor();
  const navigate = useNavigate();
  const location = useLocation();
  const isSetup = location.pathname === "/setup";
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("openai");

  const handleGenerate = async () => {
    const primary = rows.find((r) => r.isPrimary);
    if (!primary?.imageData) {
      toast.error("Adicione uma imagem na foto principal.");
      return;
    }

    setIsGenerating(true);
    try {
      const initialPrompt = primary.instructions || "Preserve the original decoration of this wedding venue";
      const { imageUrl, usedFallback } = await generateImageWithFallback({
        image: primary.imageData,
        prompt: initialPrompt,
        llmProvider,
      });

      addVersion(imageUrl);
      navigate("/editor");
      if (usedFallback) {
        toast.info("Sem créditos no provedor atual: usamos fallback automático.");
      }
      toast.success("Primeira versão gerada!");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Erro ao gerar imagem";
      console.error(e);
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <nav className="flex items-center gap-4">
        <NavLink
          to="/"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          activeClassName="text-foreground"
          end
        >
          Projetos
        </NavLink>
        <NavLink
          to="/setup"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          activeClassName="text-foreground"
        >
          Projeto em Andamento
        </NavLink>
        <NavLink
          to="/editor"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          activeClassName="text-foreground"
        >
          Editor
        </NavLink>
      </nav>

      {isSetup && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">LLM:</span>
          <Select value={llmProvider} onValueChange={(v) => setLlmProvider(v as LlmProvider)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="gemini">Gemini</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={handleGenerate} disabled={isGenerating} size="sm">
            {isGenerating ? (
              <>
                <Loader2 className="animate-spin" /> Gerando...
              </>
            ) : (
              <>
                <Sparkles /> Gerar Primeira Versão
              </>
            )}
          </Button>
        </div>
      )}
    </header>
  );
};

export default Header;
