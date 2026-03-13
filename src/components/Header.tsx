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
  const isSetup = location.pathname === "/";

  const handleGenerate = async () => {
    const primary = rows.find((r) => r.isPrimary);
    if (!primary?.imageData) {
      toast.error("Adicione uma imagem na foto principal.");
      return;
    }

    setIsGenerating(true);
    try {
      // Build content array: primary image + instructions from all rows
      const content: any[] = [];
      let promptText = "Você é um editor de imagens profissional. ";
      
      rows.forEach((row, i) => {
        if (row.isPrimary) {
          promptText += `\n\nImagem principal (Imagem ${i + 1}): Use esta como base.`;
          if (row.instructions) promptText += ` Instruções: ${row.instructions}`;
        } else if (row.imageData && row.instructions) {
          promptText += `\n\nImagem de referência ${i + 1}: ${row.instructions}. Extraia o que foi solicitado e adicione na imagem principal.`;
        }
      });

      content.push({ type: "text", text: promptText });

      // Add all images
      rows.forEach((row) => {
        if (row.imageData) {
          content.push({
            type: "image_url",
            image_url: { url: row.imageData },
          });
        }
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
        >
          Configuração
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
