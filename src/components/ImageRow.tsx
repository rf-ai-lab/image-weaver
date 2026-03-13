import { useImageEditor, type ImageRow as ImageRowType } from "@/contexts/ImageEditorContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ImagePlus, Trash2, Star } from "lucide-react";
import { useRef } from "react";

interface Props {
  row: ImageRowType;
  index: number;
}

const ImageRowComponent = ({ row, index }: Props) => {
  const { updateRow, removeRow, setPrimary, rows } = useImageEditor();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateRow(row.id, { imageData: reader.result as string });
    reader.readAsDataURL(file);
  };

  return (
    <div className={`flex items-start gap-4 rounded-lg border p-4 transition-colors ${row.isPrimary ? "border-primary bg-primary/5" : "border-border"}`}>
      {/* Primary selector */}
      <button
        type="button"
        onClick={() => setPrimary(row.id)}
        className={`mt-2 flex-shrink-0 rounded-full p-1.5 transition-colors ${row.isPrimary ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
        title={row.isPrimary ? "Foto Principal" : "Definir como Foto Principal"}
      >
        <Star className={`h-5 w-5 ${row.isPrimary ? "fill-primary" : ""}`} />
      </button>

      {/* Image upload */}
      <div
        onClick={() => fileRef.current?.click()}
        className="flex h-24 w-24 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed border-input bg-muted transition-colors hover:border-primary"
      >
        {row.imageData ? (
          <img src={row.imageData} alt={`Imagem ${index + 1}`} className="h-full w-full object-cover" />
        ) : (
          <ImagePlus className="h-6 w-6 text-muted-foreground" />
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </div>

      {/* Instructions */}
      <div className="flex-1">
        <Label className="mb-1 text-xs text-muted-foreground">
          {row.isPrimary ? "★ Foto Principal — Instruções (opcional)" : `Imagem ${index + 1} — O que extrair desta foto?`}
        </Label>
        <Textarea
          value={row.instructions}
          onChange={(e) => updateRow(row.id, { instructions: e.target.value })}
          placeholder={row.isPrimary ? "Instruções adicionais para a imagem principal..." : "Ex: Extraia o logotipo e adicione no canto superior direito"}
          className="min-h-[60px] resize-none text-sm"
        />
      </div>

      {/* Remove */}
      {rows.length > 1 && (
        <Button variant="ghost" size="icon" onClick={() => removeRow(row.id)} className="mt-1 flex-shrink-0 text-muted-foreground hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
};

export default ImageRowComponent;
