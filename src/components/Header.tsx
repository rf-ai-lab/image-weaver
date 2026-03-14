import { NavLink } from "@/components/NavLink";
import { Button } from "@/components/ui/button";
import { useImageEditor } from "@/contexts/ImageEditorContext";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const Header = () => {
  const { rows, isGenerating, setIsGenerating, addVersion } = useImageEditor();
  const navigate = useNavigate();
  const location = useLocation();
  const isSetup = location.pathname === "/setup";

  const handleGenerate = async () => {
    const primary = rows.find((r) => r.isPrimary);
    if (!primary?.imageData) {
      toast.error("Adicione uma imagem na foto principal.");
      return;
    }

    setIsGenerating(true);
    try {
      const initialPrompt = primary.instructions || "Preserve the original decoration of this wedding venue";
      
      const { data, error } = await supabase.functions.invoke("generate-decoration", {
        body: { image: primary.imageData, prompt: initialPrompt },
      });

      if (error) throw error;
      if (!data?.imageUrl) throw new Error("Nenhuma imagem retornada");

      addVersion(data.imageUrl);
      navigate("/editor");
      toast.success("Primeira versão gerada!");
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Erro ao gerar imagem");
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
      )}
    </header>
  );
};

export default Header;
