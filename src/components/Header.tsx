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
      // Build deterministic payload: primary image first, references after
      const content: any[] = [];
      const references = rows.filter((r) => !r.isPrimary && r.imageData);

      content.push({
        type: "text",
        text: "LÓGICA FIXA: a PRIMEIRA image_url é sempre a Foto Principal (estrutura macro fixa: ângulo, zoom, enquadramento e distância). Referências servem apenas para extrair objetos citados e aplicar na principal.",
      });

      content.push({
        type: "text",
        text: `Foto Principal (base estrutural obrigatória). ${primary.instructions ? `Instruções adicionais: ${primary.instructions}` : ""}`,
      });

      content.push({
        type: "image_url",
        image_url: { url: primary.imageData },
      });

      references.forEach((row, i) => {
        content.push({
          type: "text",
          text: `Imagem de referência ${i + 1}: ${row.instructions || "identifique objetos relevantes"}. Extraia apenas o que foi solicitado e aplique na foto principal sem alterar enquadramento/zoom.`,
        });
        content.push({
          type: "image_url",
          image_url: { url: row.imageData! },
        });
      });

      const { data, error } = await supabase.functions.invoke("edit-image", {
        body: { content },
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
