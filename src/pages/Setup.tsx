import { useImageEditor } from "@/contexts/ImageEditorContext";
import ImageRowComponent from "@/components/ImageRow";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

const Setup = () => {
  const { rows, addRow } = useImageEditor();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Configuração de Imagens</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Adicione imagens e defina o que extrair de cada uma. Marque uma como Foto Principal — ela será a base da edição.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row, i) => (
          <ImageRowComponent key={row.id} row={row} index={i} />
        ))}
      </div>

      <Button variant="outline" onClick={addRow} className="mt-4 w-full">
        <Plus className="h-4 w-4" /> Adicionar Linha
      </Button>
    </div>
  );
};

export default Setup;
