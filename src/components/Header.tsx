import { useImageEditor } from "@/contexts/ImageEditorContext";
import { composeImage, type ReferenceImage } from "@/lib/image-generation";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { NavLink } from "@/components/NavLink";

const Header = () => {
  const {
    rows,
    isGenerating,
    setIsGenerating,
    addVersion,
  } = useImageEditor();
  const navigate = useNavigate();
  const location = useLocation();
  const isSetup = location.pathname === "/setup";

  const handleCompose = async () => {
    const primary = rows.find((r) => r.isPrimary);
    if (!primary?.imageData) {
      toast.error("Adicione uma imagem na foto principal.");
      return;
    }

    const refs = rows.filter((r) => !r.isPrimary && r.imageData && r.instructions.trim());
    if (refs.length === 0) {
      toast.error("Adicione pelo menos uma imagem de referência com instrução.");
      return;
    }

    const references: ReferenceImage[] = refs.map((r) => ({
      image: r.imageData!,
      instruction: r.instructions.trim(),
    }));

    setIsGenerating(true);
    try {
      const { imageUrl } = await composeImage({
        baseImage: primary.imageData,
        references,
      });

      addVersion(imageUrl, `Composição: ${references.map((r) => r.instruction).join(" + ")}`);
      navigate("/editor");
      toast.success("Composição gerada!");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Erro ao compor imagem";
      console.error(e);
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <nav className="flex items-center gap-4">
        <NavLink to="/" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" activeClassName="text-foreground" end>
          Projetos
        </NavLink>
        <NavLink to="/setup" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" activeClassName="text-foreground">
          Projeto em Andamento
        </NavLink>
        <NavLink to="/editor" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" activeClassName="text-foreground">
          Editor
        </NavLink>
      </nav>

      {isSetup && (
        <div className="flex items-center gap-2">
          <Button onClick={handleCompose} disabled={isGenerating} size="sm">
            {isGenerating ? (
              <><Loader2 className="animate-spin" /> Compondo...</>
            ) : (
              <><Sparkles /> Compor Decoração</>
            )}
          </Button>
        </div>
      )}
    </header>
  );
};

export default Header;
