import { useImageEditor, type ImageRow } from "@/contexts/ImageEditorContext";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X } from "lucide-react";

interface VersionHistoryProps {
  setupImages: ImageRow[];
  selectedSetupImageIndex: number | null;
  onSelectSetupImage: (index: number) => void;
  onSelectVersion: (index: number) => void;
}

const VersionHistory = ({
  setupImages,
  selectedSetupImageIndex,
  onSelectSetupImage,
  onSelectVersion,
}: VersionHistoryProps) => {
  const { versions, currentVersionIndex, deleteVersion } = useImageEditor();

  if (setupImages.length === 0 && versions.length === 0) return null;

  return (
    <div className="border-t border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Histórico de Versões
      </h3>
      <ScrollArea className="w-full">
        <div className="flex gap-3 pb-2">
          {setupImages.map((row, i) => (
            <button
              key={row.id}
              onClick={() => onSelectSetupImage(i)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border-2 p-1.5 transition-all hover:border-primary/50",
                selectedSetupImageIndex === i ? "border-primary shadow-sm" : "border-transparent"
              )}
            >
              <img
                src={row.imageData!}
                alt={row.isPrimary ? "Foto Principal" : `Imagem de referência ${i + 1}`}
                className="h-16 w-16 rounded object-cover"
              />
              <span className="text-[10px] font-medium text-muted-foreground">
                {row.isPrimary ? "Principal" : `Setup ${i + 1}`}
              </span>
            </button>
          ))}

          {versions.map((v, i) => (
            <div key={i} className="relative group">
              <button
                onClick={() => onSelectVersion(i)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border-2 p-1.5 transition-all hover:border-primary/50",
                  selectedSetupImageIndex === null && i === currentVersionIndex
                    ? "border-primary shadow-sm"
                    : "border-transparent"
                )}
              >
                <img src={v.imageData} alt={v.label} className="h-16 w-16 rounded object-cover" />
                <span className="text-[10px] font-medium text-muted-foreground">{v.label}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteVersion(i);
                }}
                className="absolute -top-1.5 -right-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm transition-colors group-hover:flex hover:bg-destructive/90"
                title="Excluir versão"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default VersionHistory;
